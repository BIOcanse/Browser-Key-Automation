param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        if (-not ('BkaNativeErrorMode' -as [type])) {
            Add-Type -TypeDefinition 'public static class BkaNativeErrorMode { [System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode); }'
        }
        # Descendant build/test processes inherit non-dialog native failures.
        [void][BkaNativeErrorMode]::SetErrorMode(0x8003)
    }
    & $Executable @Arguments
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
