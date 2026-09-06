param([Parameter(Mandatory=$true)][uint32]$AllowedBrowserPid)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    Add-Type -LiteralPath (Join-Path $PSScriptRoot 'NativeProbe.cs')
    [NativeProbe]::Init($AllowedBrowserPid)
    [Console]::WriteLine('{"ready":true}')
    while ($null -ne ($probeLine = [Console]::ReadLine())) {
        $probeRequest = $null
        try {
            $probeRequest = $probeLine | ConvertFrom-Json -AsHashtable
            if ($probeRequest.method -eq 'stop') { break }
            $probeResult = switch ($probeRequest.method) {
                'snapshot' { [NativeProbe]::Snapshot() }
                'one' { [NativeProbe]::One([string]$probeRequest.hwnd) }
                'position' { [NativeProbe]::Position([string]$probeRequest.hwnd,[int]$probeRequest.x,[int]$probeRequest.y,[int]$probeRequest.width,[int]$probeRequest.height) }
                'foreground' { [NativeProbe]::Foreground([string]$probeRequest.hwnd) }
                'show' { [NativeProbe]::Show([string]$probeRequest.hwnd,[int]$probeRequest.command) }
                'send_timeout' { [NativeProbe]::SendTimeout([string]$probeRequest.hwnd,[int]$probeRequest.x,[int]$probeRequest.y) }
                'post_part' { [NativeProbe]::PostPart([string]$probeRequest.hwnd,[int]$probeRequest.x,[int]$probeRequest.y,[string]$probeRequest.part) }
                'no_activate' { [NativeProbe]::NoActivate([string]$probeRequest.hwnd,[bool]$probeRequest.enabled) }
                'send_input' { [NativeProbe]::SystemClick([int]$probeRequest.x,[int]$probeRequest.y,[string]$probeRequest.expectedRoot) }
                default { throw 'Unknown experiment method' }
            }
            [Console]::WriteLine((@{id=$probeRequest.id;ok=$true;result=$probeResult} | ConvertTo-Json -Depth 15 -Compress))
        } catch {
            [Console]::WriteLine((@{id=$probeRequest.id;ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Depth 5 -Compress))
        }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
} finally {
    if ('NativeProbe' -as [type]) { [NativeProbe]::Stop() }
}
