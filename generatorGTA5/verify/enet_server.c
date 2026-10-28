#include <enet/enet.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static void hex(const unsigned char *p, size_t n) { for (size_t i = 0; i < n; i++) printf("%02x", p[i]); }

int main(int argc, char **argv) {
    unsigned port = argc > 1 ? atoi(argv[1]) : 34567;
    int budget_ms = argc > 2 ? atoi(argv[2]) : 6000;
    if (enet_initialize() != 0) return 1;
    ENetAddress addr; addr.host = ENET_HOST_ANY; addr.port = port;
    ENetHost *host = enet_host_create(&addr, 8, 2, 0, 0);   /* same shape as FiveM's server host: 2 channels */
    if (!host) return 2;
    setvbuf(stdout, NULL, _IOLBF, 0);
    printf("READY\n");
    ENetEvent ev; enet_uint32 start = enet_time_get();
    while ((int)(enet_time_get() - start) < budget_ms) {
        int r = enet_host_service(host, &ev, 20);
        if (r <= 0) continue;
        if (ev.type == ENET_EVENT_TYPE_CONNECT)
            printf("CONNECT data=%u channels=%u mtu=%u\n", ev.data, (unsigned)ev.peer->channelCount, (unsigned)ev.peer->mtu);
        else if (ev.type == ENET_EVENT_TYPE_RECEIVE) {
            printf("RECEIVE ch=%u flags=%u len=%zu hex=", (unsigned)ev.channelID, (unsigned)ev.packet->flags, ev.packet->dataLength);
            hex(ev.packet->data, ev.packet->dataLength); printf("\n");
            enet_packet_destroy(ev.packet);
        } else if (ev.type == ENET_EVENT_TYPE_DISCONNECT) printf("DISCONNECT\n");
    }
    enet_host_destroy(host); enet_deinitialize();
    return 0;
}
