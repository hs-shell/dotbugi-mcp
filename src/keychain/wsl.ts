import { spawn } from 'node:child_process';
import { wslPowerShell } from '../wsl-paths.js';
import type { Keychain } from './types.js';

// WSL 에는 쓸 만한 키체인이 없어 Windows 자격 증명 관리자를 PowerShell 로 쓴다.
// 형식(일반 자격 증명, 대상 "{account}.{service}", UTF-16LE blob)은 @napi-rs/keyring 의 Windows 저장 형식과 같다.
// 스크립트는 ASCII 전용 (-EncodedCommand 로 전달), 값은 콘솔 코드페이지를 피하려고 stdin/stdout 에 base64 로 주고받는다.

const NOT_FOUND_EXIT = 3;

const PRELUDE = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class DotbugiCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr p);
}
"@
$M = [Runtime.InteropServices.Marshal]
function Exit-Failed([int]$e) { if ($e -eq 1168) { exit ${NOT_FOUND_EXIT} } else { exit 1 } }
`;

// Type 1 = CRED_TYPE_GENERIC, Persist 2 = CRED_PERSIST_LOCAL_MACHINE(로밍 안 함), 1168 = ERROR_NOT_FOUND
// Persist 2 를 고른 이유: 1(SESSION)은 Windows 로그오프 때 사라져 매번 다시 login 해야 하고,
// 3(ENTERPRISE)은 도메인 로밍 프로필을 타고 다른 PC 로 복사될 수 있다. 세션은 이 PC 에만 남긴다
const OPS = {
  set: `$s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))
$b = [Text.Encoding]::Unicode.GetBytes($s)
$c = New-Object DotbugiCred+CREDENTIAL
$c.Type = 1; $c.TargetName = $target; $c.UserName = $account; $c.Persist = 2
$c.CredentialBlobSize = $b.Length; $c.CredentialBlob = $M::AllocHGlobal($b.Length)
try { $M::Copy($b, 0, $c.CredentialBlob, $b.Length); if (-not [DotbugiCred]::CredWriteW([ref]$c, 0)) { exit 1 } }
finally { $M::Copy((New-Object byte[] $b.Length), 0, $c.CredentialBlob, $b.Length); $M::FreeHGlobal($c.CredentialBlob) }`,
  get: `$p = [IntPtr]::Zero
if (-not [DotbugiCred]::CredReadW($target, 1, 0, [ref]$p)) { Exit-Failed ($M::GetLastWin32Error()) }
try {
  $c = $M::PtrToStructure($p, [type][DotbugiCred+CREDENTIAL])
  $s = $M::PtrToStringUni($c.CredentialBlob, $c.CredentialBlobSize / 2)
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)))
} finally { [DotbugiCred]::CredFree($p) }`,
  delete: `if (-not [DotbugiCred]::CredDeleteW($target, 1, 0)) { Exit-Failed ($M::GetLastWin32Error()) }`,
};

export function createWslKeychain(service: string, account: string): Keychain {
  const run = (op: keyof typeof OPS, input = '') =>
    runPowerShell(`${PRELUDE}$target = '${account}.${service}'; $account = '${account}'\n${OPS[op]}`, input);
  return {
    async get() {
      const { code, stdout } = await run('get');
      if (code === NOT_FOUND_EXIT) return null;
      if (code !== 0) throw new Error('Windows 자격 증명 관리자에서 읽지 못했습니다.');
      return Buffer.from(stdout, 'base64').toString('utf8');
    },
    async set(value) {
      const { code } = await run('set', Buffer.from(value, 'utf8').toString('base64'));
      if (code !== 0) throw new Error('Windows 자격 증명 관리자에 저장하지 못했습니다.');
    },
    async delete() {
      const { code } = await run('delete');
      if (code === NOT_FOUND_EXIT) return false;
      if (code !== 0) throw new Error('Windows 자격 증명 관리자에서 삭제하지 못했습니다.');
      return true;
    },
  };
}

// PATH 를 거치지 않고 절대경로의 powershell.exe 만 실행한다. stderr 는 값이 섞일 수 있어 버린다
function runPowerShell(script: string, input: string): Promise<{ code: number | null; stdout: string }> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
  return new Promise((resolve, reject) => {
    const child = spawn(wslPowerShell(), args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.once('error', () => reject(new Error('powershell.exe 를 실행하지 못했습니다.')));
    child.once('close', (code) => resolve({ code, stdout: stdout.trim() }));
    child.stdin.end(input);
  });
}
