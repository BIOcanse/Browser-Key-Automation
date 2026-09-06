#ifndef BKA_VM_WIRE_H
#define BKA_VM_WIRE_H
#include <windows.h>
#include <stdint.h>

#define VM_MAGIC 0x564D3032u
#define VM_CONTROL_NAME L"BKA.VirtualInput.Control.v2"
#define VM_OWNER_PROPERTY L"BKA.VirtualInput.Owner.v2"
#define VM_OWNER_TIME_PROPERTY L"BKA.VirtualInput.OwnerTime.v2"
#define VM_READY 0x564D4F4Bu
enum { VM_ATTACH = 1, VM_EVENT = 2, VM_DETACH = 3 };
enum { VM_MOVE = 1, VM_DOWN = 2, VM_UP = 3, VM_WHEEL = 4, VM_KEY_DOWN = 5, VM_KEY_UP = 6 };
enum { VM_OK = 0, VM_INVALID = 1, VM_TARGET_LOST = 2, VM_CONFLICT = 3,
       VM_HOOK_FAILED = 4, VM_TIMEOUT = 5, VM_DELIVERY_FAILED = 6 };

/* The host writes one command at a time. SendMessageTimeout is the handoff;
   the target writes only acknowledgement/observed capture, never host state. */
typedef struct VmShared {
    uint32_t magic, bytes, owner_pid, target_pid, target_tid;
    uintptr_t target_hwnd, token;
    volatile LONG enabled;
    volatile LONG filter_input;
    uintptr_t source_tag;
    uint8_t keys[256];
    uint32_t key_vk, key_extended;
    uint32_t event_kind, buttons, button;
    int32_t x, y, delta_x, delta_y;
    volatile LONG ack;
    uint32_t captured;
} VmShared;

typedef struct VmClient VmClient;
int vm_open(uintptr_t hwnd, uint32_t timeout_ms, VmClient **output);
int vm_intercept(VmClient *client, int enabled);
int vm_event(VmClient *client, uint32_t kind, int32_t x, int32_t y,
             uint32_t buttons, uint32_t button, int32_t dx, int32_t dy);
int vm_alive(VmClient *client);
int vm_is_intercepting(VmClient *client);
void vm_begin(VmClient *client, uint32_t timeout_ms);
void vm_bounds(VmClient *client, int32_t *width, int32_t *height);
void vm_close(VmClient *client);
int vm_context(VmClient *client, const uint8_t *keys, uintptr_t source_tag, int32_t x, int32_t y, uint32_t buttons);
int vm_key_event(VmClient *client, uint32_t vk, int extended, int down);
int vm_detach(VmClient *client);

static WPARAM vm_button_flags(uint32_t buttons) {
    return ((buttons & 1) ? MK_LBUTTON : 0) | ((buttons & 2) ? MK_RBUTTON : 0) |
           ((buttons & 4) ? MK_MBUTTON : 0) | ((buttons & 8) ? MK_XBUTTON1 : 0) |
           ((buttons & 16) ? MK_XBUTTON2 : 0);
}
static UINT vm_button_message(uint32_t button, int down) {
    if (button == 1) return down ? WM_LBUTTONDOWN : WM_LBUTTONUP;
    if (button == 2) return down ? WM_RBUTTONDOWN : WM_RBUTTONUP;
    if (button == 4) return down ? WM_MBUTTONDOWN : WM_MBUTTONUP;
    return down ? WM_XBUTTONDOWN : WM_XBUTTONUP;
}
#endif
