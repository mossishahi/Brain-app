/* LD_PRELOAD shim: force TCP keepalive on every TCP socket of the process.
 *
 * Why it exists: Azure (and most cloud NATs) silently drop TCP flows that
 * stay quiet for ~4 minutes — no reset, just a black hole. Long-lived model
 * API connections regularly pause longer than that mid-run, and the next
 * write then wedges for the kernel's ~15-minute retransmission window.
 * Kernel keepalive probes (idle 60s, interval 30s, 4 probes) keep the flow
 * visibly alive to the NAT and detect a dead peer within ~3 minutes.
 *
 * Node.js does not enable SO_KEEPALIVE on sockets it does not own directly
 * (the Cursor SDK's transport creates its own), so the deployment forces it
 * here, at the socket() boundary, for the server and every worker it spawns.
 *
 * Build:  gcc -shared -fPIC -O2 -o libkeepalive.so tcp-keepalive.c -ldl
 * Use:    Environment=LD_PRELOAD=/path/to/libkeepalive.so   (systemd unit)
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>

int socket(int domain, int type, int protocol) {
  static int (*real_socket)(int, int, int) = 0;
  if (!real_socket) real_socket = dlsym(RTLD_NEXT, "socket");
  int fd = real_socket(domain, type, protocol);
  /* SOCK_STREAM lives in the low bits; SOCK_NONBLOCK/SOCK_CLOEXEC are flags. */
  if (fd >= 0 && (domain == AF_INET || domain == AF_INET6) &&
      (type & 0xF) == SOCK_STREAM) {
    int on = 1, idle = 60, interval = 30, count = 4;
    setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &on, sizeof on);
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof idle);
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &interval, sizeof interval);
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &count, sizeof count);
  }
  return fd;
}
