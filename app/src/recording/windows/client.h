#ifndef BKA_RECORDING_CLIENT_H
#define BKA_RECORDING_CLIENT_H
#include "types.h"

typedef struct RcClient RcClient;
enum { RC_OK = 0, RC_INVALID = 1, RC_TARGET = 2, RC_CONFLICT = 3,
    RC_INSTALL_FAILED = 4, RC_PENDING = 5, RC_CURSOR = 6, RC_UNACKNOWLEDGED = 7,
    RC_THREAD_LIMIT = 8 };
typedef struct RcStatus {
    uint32_t reason, reserved, acknowledged, delivered, lost, attached, detached, callbacks, cleanup, snapshot_valid;
    /* False for external low-level observation; retained in stored status. */
    uint32_t enrolled_threads_only;
    uint32_t pending_installations;
    int64_t started_qpc, qpc_frequency;
    RcEvent geometry;
    uint32_t geometry_valid;
    int64_t started_unix_ms;
} RcStatus;

/* A pending start still returns an owned resource that must be stopped/closed. */
int rc_open(uintptr_t root, uint32_t capacity, uint32_t duration_ms, uint32_t timeout_ms, RcClient **output);
int rc_read(RcClient *client, uint32_t acknowledge_through, RcEvent *events, uint32_t limit, uint32_t *count, RcStatus *status);
int rc_stop(RcClient *client, uint32_t timeout_ms, RcStatus *status);
int rc_close(RcClient *client, uint32_t timeout_ms, int discard_unacknowledged, RcStatus *status);
#endif
