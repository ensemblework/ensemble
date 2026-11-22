# Ensemble's Windows session probe: what cua-driver does not say about the owner's session. JSON-RPC 2.0 over
# stdin and stdout, one object per line, the desktop helper's protocol (apps/hub-api/src/desktop/control/protocol.ts):
#   hello   the protocol, this probe's version and its methods
#   idle    idle_ms (GetLastInputInfo), the input desktop's name, locked (it is not "Default": the lock screen,
#           the secure desktop of User Account Control, a screen saver) and uac (consent.exe runs)
#   state   the same, plus the session (its id, 0 for a service's; its connect state; whether its window station
#           shows), UI Automation, and the monitors with their DPI
#   notify  a notice on the owner's screen (a toast)
# It reads and shows only: it never sends input, takes no screenshot and opens no port.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
# Without a console of its own (pipes only) Windows may refuse to change the console's code pages.
try { [Console]::InputEncoding = $utf8 } catch { }
try { [Console]::OutputEncoding = $utf8 } catch { }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class EnsembleProbe {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] struct USEROBJECTFLAGS { public int fInherit; public int fReserved; public int dwFlags; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  delegate bool MonitorEnum(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);

  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, int length, out int needed);
  [DllImport("user32.dll", SetLastError = true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, ref USEROBJECTFLAGS info, int length, out int needed);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint session);
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnum callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);

  // Screen pixels, like cua-driver (per-monitor DPI aware v2).
  public static void PerMonitor() { try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { } }

  public static long IdleMs() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return -1;
    return (long)unchecked((uint)Environment.TickCount - info.dwTime);
  }

  // The desktop that gets input now: "Default" while the owner's desktop shows; null when this session may not
  // open it (the secure desktop of the lock screen or of User Account Control).
  public static string InputDesktop() {
    IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
    if (desktop == IntPtr.Zero) return null;
    try {
      StringBuilder name = new StringBuilder(256);
      int needed;
      return GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed) ? name.ToString() : null;
    } finally { CloseDesktop(desktop); }
  }

  public static long SessionId() { uint session; return ProcessIdToSessionId(GetCurrentProcessId(), out session) ? (long)session : -1L; }

  public static int ConnectState(long session) {
    IntPtr buffer; int bytes;
    if (session < 0 || !WTSQuerySessionInformation(IntPtr.Zero, (int)session, 8, out buffer, out bytes)) return -1;
    try { return Marshal.ReadInt32(buffer); } finally { WTSFreeMemory(buffer); }
  }

  public static bool VisibleStation() {
    USEROBJECTFLAGS flags = new USEROBJECTFLAGS();
    int needed;
    if (!GetUserObjectInformation(GetProcessWindowStation(), 1, ref flags, Marshal.SizeOf(flags), out needed)) return false;
    return (flags.dwFlags & 1) != 0;
  }

  public static uint SystemDpi() { try { return GetDpiForSystem(); } catch { return 96; } }

  public static List<int[]> Monitors() {
    List<int[]> found = new List<int[]>();
    MonitorEnum each = delegate (IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data) {
      MONITORINFO info = new MONITORINFO();
      info.cbSize = Marshal.SizeOf(info);
      if (GetMonitorInfo(monitor, ref info)) {
        uint dpiX = 96, dpiY = 96;
        try { GetDpiForMonitor(monitor, 0, out dpiX, out dpiY); } catch { }
        RECT r = info.rcMonitor;
        found.Add(new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, (int)(info.dwFlags & 1), (int)dpiX });
      }
      return true;
    };
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, each, IntPtr.Zero);
    GC.KeepAlive(each);
    return found;
  }
}
'@

[EnsembleProbe]::PerMonitor()
$Version = '1'
$Methods = @('hello', 'idle', 'state', 'notify')
$ConnectStates = @('active', 'connected', 'connect_query', 'shadow', 'disconnected', 'idle', 'listen', 'reset', 'down', 'init')

function Send($message) {
  [Console]::Out.WriteLine(($message | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

function Running($name) {
  return [bool](Get-Process -Name $name -ErrorAction SilentlyContinue)
}

function Idle {
  $desktop = [EnsembleProbe]::InputDesktop()
  $idle = [EnsembleProbe]::IdleMs()
  $uac = Running 'consent'
  return [ordered]@{
    idle_ms = $(if ($idle -ge 0) { $idle } else { $null })
    input_desktop = $desktop
    locked = ($desktop -ne 'Default')
    uac = $uac
    lock_screen = ((-not $uac) -and ($desktop -ne 'Default') -and (Running 'LogonUI'))
  }
}

function State {
  $now = Idle
  $session = [EnsembleProbe]::SessionId()
  $connect = [EnsembleProbe]::ConnectState($session)
  $uia = $false
  $uiaError = $null
  try {
    Add-Type -AssemblyName UIAutomationClient
    $uia = $null -ne [System.Windows.Automation.AutomationElement]::RootElement
  } catch { $uiaError = $_.Exception.Message }
  $monitors = @([EnsembleProbe]::Monitors() | ForEach-Object { [ordered]@{ x = $_[0]; y = $_[1]; width = $_[2]; height = $_[3]; primary = ($_[4] -eq 1); dpi = $_[5] } })
  $now['session'] = [ordered]@{
    id = $session
    service = ($session -eq 0)
    connect = $(if ($connect -ge 0 -and $connect -lt $ConnectStates.Count) { $ConnectStates[$connect] } else { $null })
    visible = [EnsembleProbe]::VisibleStation()
  }
  $now['uia'] = $uia
  if ($uiaError) { $now['uia_error'] = $uiaError }
  $now['dpi'] = [EnsembleProbe]::SystemDpi()
  $now['monitors'] = $monitors
  $now['os'] = [Environment]::OSVersion.Version.ToString()
  return $now
}

function Notify($params) {
  $title = [string]$params.title
  $body = [string]$params.body
  try {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $template.GetElementsByTagName('text')
    [void]$texts.Item(0).AppendChild($template.CreateTextNode($title.Substring(0, [Math]::Min(120, $title.Length))))
    [void]$texts.Item(1).AppendChild($template.CreateTextNode($body.Substring(0, [Math]::Min(300, $body.Length))))
    $toast = New-Object Windows.UI.Notifications.ToastNotification $template
    $shell = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($shell).Show($toast)
    return [ordered]@{ shown = $true }
  } catch {
    return [ordered]@{ shown = $false; error = $_.Exception.Message }
  }
}

function Answer($request) {
  switch ([string]$request.method) {
    'hello' { return [ordered]@{ result = [ordered]@{ protocol = 1; version = $Version; platform = 'win32'; methods = $Methods; session = 'windows' } } }
    'idle' { return [ordered]@{ result = (Idle) } }
    'state' { return [ordered]@{ result = (State) } }
    'notify' { return [ordered]@{ result = (Notify $request.params) } }
  }
  return [ordered]@{ error = [ordered]@{ code = -32601; message = "The Windows probe has no method $($request.method)."; data = [ordered]@{ kind = 'method_not_found'; ran = 'no' } } }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  try { $request = $line | ConvertFrom-Json } catch { continue }
  if ($null -eq $request.id) { continue }
  try {
    $answer = Answer $request
  } catch {
    $answer = [ordered]@{ error = [ordered]@{ code = -32603; message = $_.Exception.Message; data = [ordered]@{ kind = 'internal'; ran = 'no' } } }
  }
  $answer['jsonrpc'] = '2.0'
  $answer['id'] = $request.id
  Send $answer
}
