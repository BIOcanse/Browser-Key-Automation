/* A private, never activated desktop tests native geometry/visibility. Mouse
   callback records are synthetic; hardware input and the user's cursor stay untouched. */
#include "client.c"
#include <stdio.h>
#include <wchar.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"window recording line %d: %s\n",__LINE__,#x); return 1; } } while(0)
static LRESULT CALLBACK fixture(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) { return DefWindowProcW(hwnd,message,wp,lp); }
static void sample(RcClient *c, UINT message, int x, int y, DWORD data) {
    RECT r; GetWindowRect(c->root,&r);
    MSLLHOOKSTRUCT input={0}; input.pt=(POINT){r.left+x,r.top+y};input.mouseData=data;input.time=GetTickCount();
    record_mouse(c,message,&input);
}
static int child(void) {
    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    WNDCLASSW wc={0};wc.lpfnWndProc=fixture;wc.hInstance=GetModuleHandleW(NULL);wc.lpszClassName=L"BKA.Recording.Window.Test";
    CHECK(RegisterClassW(&wc));
    HWND root=CreateWindowExW(0,wc.lpszClassName,L"fixture",WS_OVERLAPPEDWINDOW,100,100,600,500,NULL,NULL,wc.hInstance,NULL);
    CHECK(root);ShowWindow(root,SW_SHOWNOACTIVATE);
    RcClient *c=NULL;CHECK(rc_open((uintptr_t)root,128,5000,2000,&c)==RC_OK);
    RcEvent events[128];RcStatus status;uint32_t count;
    sample(c,WM_MOUSEMOVE,150,160,0);
    sample(c,WM_LBUTTONDOWN,150,160,0);sample(c,WM_LBUTTONUP,150,160,0);
    sample(c,WM_RBUTTONDOWN,150,160,0);sample(c,WM_RBUTTONUP,150,160,0);
    sample(c,WM_MBUTTONDOWN,150,160,0);sample(c,WM_MBUTTONUP,150,160,0);
    sample(c,WM_XBUTTONDOWN,150,160,XBUTTON1<<16);sample(c,WM_XBUTTONUP,150,160,XBUTTON1<<16);
    sample(c,WM_XBUTTONDOWN,150,160,XBUTTON2<<16);sample(c,WM_XBUTTONUP,150,160,XBUTTON2<<16);
    sample(c,WM_MOUSEWHEEL,150,160,(DWORD)(WORD)-120<<16);sample(c,WM_MOUSEHWHEEL,150,160,120<<16);
    CHECK(SetWindowPos(root,NULL,220,170,720,560,SWP_NOACTIVATE|SWP_NOZORDER));
    sample(c,WM_MOUSEMOVE,150,160,0);
    sample(c,WM_MOUSEMOVE,-100,-100,0);sample(c,WM_XBUTTONDOWN,-50,-50,XBUTTON1<<16);
    HWND cover=CreateWindowExW(WS_EX_TOPMOST,wc.lpszClassName,L"cover",WS_POPUP,220,170,720,560,NULL,NULL,wc.hInstance,NULL);
    CHECK(cover);ShowWindow(cover,SW_SHOWNOACTIVATE);
    sample(c,WM_MOUSEMOVE,150,160,0);sample(c,WM_XBUTTONDOWN,150,160,XBUTTON2<<16);
    DestroyWindow(cover);ShowWindow(root,SW_MINIMIZE);sample(c,WM_MOUSEMOVE,150,160,0);
    CHECK(rc_stop(c,2000,&status)==RC_OK && status.cleanup && !status.enrolled_threads_only);
    CHECK(rc_read(c,0,events,128,&count,&status)==RC_OK);
    unsigned inputs=0,back=0,forward=0,wheel=0,changed=0;
    for(unsigned i=0;i<count;i++) {
        RcEvent *e=&events[i];CHECK(e->sequence==i+1);
        if(e->kind!=RC_INPUT) {CHECK(!e->point_valid);continue;}
        ++inputs;CHECK(e->point_valid && e->x==150 && e->y==160);
        if(e->message==WM_XBUTTONDOWN||e->message==WM_XBUTTONUP) {
            if(HIWORD(e->wparam)==XBUTTON1)back++;if(HIWORD(e->wparam)==XBUTTON2)forward++;
        }
        if(e->message==WM_MOUSEWHEEL||e->message==WM_MOUSEHWHEEL)wheel++;
        if(e->window.left==220&&e->window.top==170)changed++;
    }
    CHECK(inputs==14 && back==2 && forward==2 && wheel==2 && changed==1);
    uint32_t first_count=count;CHECK(rc_read(c,0,events,128,&count,&status)==RC_OK && count==first_count);
    CHECK(rc_close(c,100,0,&status)==RC_UNACKNOWLEDGED);
    CHECK(rc_read(c,first_count+1,events,128,&count,&status)==RC_CURSOR);
    CHECK(rc_read(c,first_count,events,128,&count,&status)==RC_OK && count==0);
    CHECK(rc_close(c,100,0,&status)==RC_OK);
    ShowWindow(root,SW_SHOWNOACTIVATE);
    CHECK(rc_open((uintptr_t)root,2,5000,2000,&c)==RC_OK);
    sample(c,WM_MOUSEMOVE,150,160,0);sample(c,WM_MOUSEMOVE,151,160,0);
    CHECK(rc_stop(c,2000,&status)==RC_OK && status.reason==RC_OVERFLOW && status.lost>0);
    CHECK(rc_close(c,100,1,&status)==RC_OK);
    DestroyWindow(root);
    puts("window recorder: five-button encoding, wheel, moved window, outside/occluded/minimized filtering, ACK, overflow and cleanup passed");
    return 0;
}
int main(int argc,char **argv) {
    if(argc==2)return child();
    wchar_t desktop_name[96],program[32768],command[33000];
    swprintf(desktop_name,96,L"BKA.Recording.Test.%lu.%llu",GetCurrentProcessId(),GetTickCount64());
    HDESK desktop=CreateDesktopW(desktop_name,NULL,NULL,0,DESKTOP_CREATEWINDOW|DESKTOP_READOBJECTS|DESKTOP_WRITEOBJECTS|DESKTOP_HOOKCONTROL|DESKTOP_ENUMERATE,NULL);
    CHECK(desktop);
    CHECK(GetModuleFileNameW(NULL,program,32768));swprintf(command,33000,L"\"%s\" child",program);
    STARTUPINFOW start={0};start.cb=sizeof(start);start.lpDesktop=desktop_name;
    PROCESS_INFORMATION process={0};
    CHECK(CreateProcessW(program,command,NULL,NULL,TRUE,0,NULL,NULL,&start,&process));
    DWORD wait=WaitForSingleObject(process.hProcess,10000),code=1;
    if(wait==WAIT_OBJECT_0)GetExitCodeProcess(process.hProcess,&code);else TerminateProcess(process.hProcess,1);
    CloseHandle(process.hThread);CloseHandle(process.hProcess);CloseDesktop(desktop);return (int)code;
}
