using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Experiment only. Every input/geometry mutation is restricted to a freshly
// launched browser PID supplied by the runner. No product endpoint or Key.
public static class NativeProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public uint cbSize, flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG {
    public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam;
    public uint time; public POINT pt; public uint lPrivate;
  }
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr hwnd, StringBuilder text, int maximum);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int maximum);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessageW(IntPtr hwnd,uint msg,UIntPtr wp,IntPtr lp);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] static extern IntPtr SetWindowLongPtr(IntPtr hwnd,int index,IntPtr value);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint msg, UIntPtr wp, IntPtr lp, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
  [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);

  static uint browserPid;
  static volatile bool running;
  static Thread hookThread;
  static readonly ConcurrentQueue<object> eventLog = new ConcurrentQueue<object>();
  static readonly ManualResetEventSlim hookReady = new ManualResetEventSlim(false);
  static WinEventProc callback;
  public static void Init(uint pid) {
    browserPid = pid;
    SetErrorMode(0x8003);
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    running = true;
    hookThread = new Thread(HookLoop); hookThread.IsBackground = true; hookThread.Start();
    if (!hookReady.Wait(1500)) throw new Exception("WinEvent hook startup timed out");
  }
  static string H(IntPtr hwnd) { return "0x" + hwnd.ToInt64().ToString("X"); }
  static IntPtr P(string value) { return new IntPtr(Convert.ToInt64(value.StartsWith("0x") ? value.Substring(2) : value, value.StartsWith("0x") ? 16 : 10)); }
  static uint Owner(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); return pid; }
  static void Check(IntPtr hwnd) { if (!IsWindow(hwnd) || Owner(hwnd) != browserPid) throw new Exception("Target is not a live window of this isolated browser PID"); }
  static object Rect(RECT r) { return new { x=r.Left, y=r.Top, width=r.Right-r.Left, height=r.Bottom-r.Top }; }
  static object Describe(IntPtr hwnd) {
    Check(hwnd);
    RECT wr, cr; GetWindowRect(hwnd, out wr); GetClientRect(hwnd, out cr);
    POINT origin = new POINT(); ClientToScreen(hwnd, ref origin);
    var cls = new StringBuilder(256); GetClassNameW(hwnd, cls, cls.Capacity);
    var title = new StringBuilder(512); GetWindowTextW(hwnd, title, title.Capacity);
    uint pid; uint thread = GetWindowThreadProcessId(hwnd, out pid);
    GUITHREADINFO gui = new GUITHREADINFO(); gui.cbSize = (uint)Marshal.SizeOf<GUITHREADINFO>();
    bool guiOk = GetGUIThreadInfo(thread, ref gui);
    return new { hwnd=H(hwnd), parent=H(GetParent(hwnd)), root=H(GetAncestor(hwnd,2)), pid, thread,
      className=cls.ToString(), title=title.ToString(), visible=IsWindowVisible(hwnd), iconic=IsIconic(hwnd), enabled=IsWindowEnabled(hwnd),
      windowRect=Rect(wr), clientRect=Rect(cr), clientOrigin=new {x=origin.X,y=origin.Y}, dpi=GetDpiForWindow(hwnd), extendedStyle=GetWindowLongPtr(hwnd,-20).ToInt64(),
      gui=new { available=guiOk, active=H(gui.hwndActive), focus=H(gui.hwndFocus), capture=H(gui.hwndCapture), flags=gui.flags } };
  }
  public static object Snapshot() {
    var tops = new List<IntPtr>();
    EnumWindows((hwnd,p) => { if (Owner(hwnd)==browserPid) tops.Add(hwnd); return tops.Count < 256; }, IntPtr.Zero);
    var all = new List<object>(); var seen = new HashSet<IntPtr>(); var pending = new Stack<IntPtr>();
    for (int i=tops.Count-1; i>=0; i--) pending.Push(tops[i]);
    while (pending.Count>0 && all.Count<1024) {
      var hwnd=pending.Pop(); if (!seen.Add(hwnd) || !IsWindow(hwnd) || Owner(hwnd)!=browserPid) continue;
      all.Add(Describe(hwnd));
      var children=new List<IntPtr>(); var child=GetWindow(hwnd,5); int count=0;
      while (child!=IntPtr.Zero && count++<512) { children.Add(child); child=GetWindow(child,2); }
      for (int i=children.Count-1;i>=0;i--) pending.Push(children[i]);
    }
    POINT cursor; GetCursorPos(out cursor); var fg=GetForegroundWindow();
    return new { at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), browserPid,
      foreground=new {hwnd=H(fg),pid=Owner(fg)}, cursor=new{x=cursor.X,y=cursor.Y},
      desktop=new{x=GetSystemMetrics(76),y=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79),primaryWidth=GetSystemMetrics(0),primaryHeight=GetSystemMetrics(1)},
      topOrder=tops.ConvertAll(H), windows=all, nativeEvents=DrainEvents() };
  }
  public static object One(string hwnd) { return Describe(P(hwnd)); }
  public static object Position(string hwnd,int x,int y,int width,int height) {
    var h=P(hwnd); Check(h); bool ok=SetWindowPos(h,IntPtr.Zero,x,y,width,height,0x14);
    return new{api="SetWindowPos",ok,error=ok?0:Marshal.GetLastWin32Error(),flags="SWP_NOACTIVATE|SWP_NOZORDER",window=Describe(h)};
  }
  public static object Foreground(string hwnd) {
    var h=P(hwnd); Check(h); bool ok=SetForegroundWindow(h);
    return new{api="SetForegroundWindow",ok,requested=H(h),actual=H(GetForegroundWindow()),window=Describe(h)};
  }
  public static object Show(string hwnd,int command) {
    if(command!=6 && command!=9 && command!=4) throw new Exception("Only minimize/restore/show-no-activate allowed");
    var h=P(hwnd); Check(h); bool wasVisible=ShowWindow(h,command);
    return new{api="ShowWindow",command,wasVisible,window=Describe(h)};
  }
  public static object SendTimeout(string hwnd,int x,int y) {
    var h=P(hwnd); Check(h); var lp=new IntPtr(((long)(y & 65535)<<16)|(long)(x & 65535));
    var results=new List<object>(); uint[] messages={0x200,0x201,0x202};
    foreach(var message in messages) {
      UIntPtr result; var accepted=SendMessageTimeoutW(h,message,new UIntPtr(message==0x201?1u:0u),lp,3,500,out result);
      results.Add(new{message,accepted=accepted!=IntPtr.Zero,error=accepted!=IntPtr.Zero?0:Marshal.GetLastWin32Error(),result=result.ToUInt64()});
      if(message==0x201) Thread.Sleep(20);
    }
    return new{api="SendMessageTimeoutW",hwnd=H(h),x,y,results};
  }
  public static object PostPart(string hwnd,int x,int y,string part) {
    var h=P(hwnd); Check(h);
    uint message=part=="move"?0x200u:part=="down"?0x201u:part=="up"?0x202u:0;
    if(message==0) throw new Exception("Unknown mouse part");
    var lp=new IntPtr(((long)(y&65535)<<16)|(long)(x&65535));
    bool ok=PostMessageW(h,message,new UIntPtr(part=="down"?1u:0u),lp);
    return new{api="PostMessageW",hwnd=H(h),x,y,part,message,ok,error=ok?0:Marshal.GetLastWin32Error()};
  }
  public static object NoActivate(string hwnd,bool enabled) {
    var h=P(hwnd); Check(h); long before=GetWindowLongPtr(h,-20).ToInt64();
    long next=enabled?before|0x08000000:before&~0x08000000;
    SetWindowLongPtr(h,-20,new IntPtr(next));
    return new{api="SetWindowLongPtrW",flag="WS_EX_NOACTIVATE",before,requested=next,actual=GetWindowLongPtr(h,-20).ToInt64()};
  }
  public static object SystemClick(int x,int y,string expectedRoot) {
    var root=P(expectedRoot); Check(root);
    if((GetAsyncKeyState(1)&0x8000)!=0 || (GetAsyncKeyState(2)&0x8000)!=0 || (GetAsyncKeyState(4)&0x8000)!=0 ||
       (GetAsyncKeyState(16)&0x8000)!=0 || (GetAsyncKeyState(17)&0x8000)!=0 || (GetAsyncKeyState(18)&0x8000)!=0)
      throw new Exception("Held user mouse/modifier; no system input sent");
    var hit=WindowFromPoint(new POINT{X=x,Y=y});
    if(hit==IntPtr.Zero || Owner(hit)!=browserPid || GetAncestor(hit,2)!=root) throw new Exception("Screen point is not over the expected isolated test window; no input sent");
    int vx=GetSystemMetrics(76),vy=GetSystemMetrics(77),vw=GetSystemMetrics(78),vh=GetSystemMetrics(79);
    var inputs=new INPUT[3];
    inputs[0].data.mi=new MOUSEINPUT{dx=(int)Math.Round((x-vx)*65535.0/(vw-1)),dy=(int)Math.Round((y-vy)*65535.0/(vh-1)),dwFlags=0xC001};
    inputs[1].data.mi=new MOUSEINPUT{dwFlags=2}; inputs[2].data.mi=new MOUSEINPUT{dwFlags=4};
    uint sent=SendInput(3,inputs,Marshal.SizeOf<INPUT>()); int error=sent==3?0:Marshal.GetLastWin32Error();
    uint releaseSent=0;
    if(sent==2) releaseSent=SendInput(1,new[]{inputs[2]},Marshal.SizeOf<INPUT>());
    return new{api="SendInput",requested=3,sent,error,releaseSent,screenPoint=new{x,y},expectedRoot=H(root),hitWindow=H(hit),inputStructSize=Marshal.SizeOf<INPUT>()};
  }
  static void HookLoop() {
    callback=(hook,ev,hwnd,obj,child,thread,time)=> {
      if(eventLog.Count>=2048 || hwnd==IntPtr.Zero) return;
      uint pid=Owner(hwnd); if(ev!=3 && pid!=browserPid) return;
      eventLog.Enqueue(new{at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),ev,hwnd=H(hwnd),pid,obj,child,thread,eventTime=time});
    };
    var foreground=SetWinEventHook(3,3,IntPtr.Zero,callback,0,0,0);
    var focus=SetWinEventHook(0x8005,0x8005,IntPtr.Zero,callback,browserPid,0,0);
    hookReady.Set();
    while(running) {
      MSG msg; int count=0;
      while(PeekMessage(out msg,IntPtr.Zero,0,0,1) && count++<256) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
      Thread.Sleep(5);
    }
    if(foreground!=IntPtr.Zero) UnhookWinEvent(foreground);
    if(focus!=IntPtr.Zero) UnhookWinEvent(focus);
  }
  public static object[] DrainEvents() { var values=new List<object>(); object value; while(eventLog.TryDequeue(out value)) values.Add(value); return values.ToArray(); }
  public static void Stop() { running=false; if(hookThread!=null) hookThread.Join(1000); }
}
