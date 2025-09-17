// Multicast socket and network utility routines for ka9q-radio
// Copyright 2018-2025 Phil Karn, KA9Q

#define _GNU_SOURCE 1

#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <string.h>
#include <net/if.h>
#include <limits.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/ioctl.h>
#include <ifaddrs.h>
#include <fcntl.h>
#include <errno.h>
#include <netinet/in.h>
#include <sysexits.h>

#if defined(linux)
#include <linux/if_packet.h>
#include <net/ethernet.h>
#include <bsd/string.h>
#include <sys/prctl.h>
#include <linux/capability.h>
#endif

#ifdef __APPLE__
#include <net/if_dl.h>
#endif

#include "multicast.h"
#include "rtp.h"
#include "misc.h"

static int Loopback_index = 0;
static char Loopback_name[IFNAMSIZ];

static int setup_ipv4_loopback(int fd);
static int setup_ipv6_loopback(int fd);
static int ssm_join_group(int const fd,struct sockaddr const *source,struct sockaddr const *group,char const * const iface);
static int loopback_index(void);
static uint32_t get_local_address_for(uint32_t dest_addr);
static int get_interface_index_for_destination(struct sockaddr const *dest);
static int iface_index_from_address(struct sockaddr const *addr);
static bool is_multicast(struct sockaddr const *group);

// This is a bit messy. Is there a better way?
char const *Default_mcast_iface;


// Set up multicast socket for input or output

// Target points to string in the form of "domain[:port][,iface]"
// If target and sock are both non-null, the target will be resolved and copied into the sock structure
// If sock is null, the results of resolving target will not be stored there
// If target is null and sock is non-null, the existing sock structure contents will be used

// when output == true, connect to the multicast address so we can simply send() to it without specifying a destination
// when output == false, bind to it so we'll accept incoming packets
// Add parameter 'offset' (normally 0) to port number; this will be 1 when sending RTCP messages
// (Can we set up a socket for both input and output??)
int setup_mcast(char const * const source, struct sockaddr *source_sock, char const * const group, struct sockaddr *group_sock, bool const output, int const ttl, int const tos, int const offset, int tries){
  if(group == NULL && group_sock == NULL)
    return -1; // At least one must be supplied

  if(group_sock == NULL){
    group_sock = alloca(sizeof(struct sockaddr_storage));
    memset(group_sock, 0, sizeof(struct sockaddr_storage));
  }
  char iface[1024];
  iface[0] = '\0';
  if(group){
    int ret = resolve_mcast(group, group_sock, DEFAULT_RTP_PORT+offset, iface, sizeof(iface), tries);
    if(ret == -1)
      return -1;
  }
  if(strlen(iface) == 0 && Default_mcast_iface != NULL)
    strlcpy(iface, Default_mcast_iface, sizeof(iface));

  if((source != NULL || source_sock != NULL) && !output){
    // Source specific is being used
    if(source_sock == NULL){
      source_sock = alloca(sizeof(struct sockaddr_storage));
      memset(source_sock, 0, sizeof(struct sockaddr_storage));
    }
    int ret = resolve_mcast(source, source_sock, 0, NULL, 0, 2);
    if(ret == -1)
      return -1;
  }
  if(!output)
    return listen_mcast(source_sock, group_sock, iface);
  else
    return connect_mcast(group_sock, iface, ttl, tos);
}

// Set up a disconnected socket for output
// Like connect_mcast() but without the connect()
int output_mcast(void const * const group, char const * const iface, int const ttl, int const tos){
  if(group == NULL)
    return -1;

  struct sockaddr const *group_sock = (struct sockaddr const *)group;
  if(group_sock->sa_family != AF_INET && group_sock->sa_family != AF_INET6){
    fprintf(stderr,"output_mcast unsupported group address family %d\n",group_sock->sa_family);
    return -1;
  }

  int fd = socket(group_sock->sa_family, SOCK_DGRAM, 0);
  if(fd == -1)
    return -1;

  // Better to drop a packet than to block real-time processing
  fcntl(fd, F_SETFL, O_NONBLOCK);
  if(ttl >= 0){
    // Only needed on output
    int mcast_ttl = ttl;
    int r = 0;
    if(group_sock->sa_family == AF_INET)
      r = setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &mcast_ttl, sizeof(mcast_ttl));
    else
      r = setsockopt(fd, IPPROTO_IPV6, IPV6_MULTICAST_HOPS, &mcast_ttl, sizeof(mcast_ttl));
    if(r)
      fprintf(stderr,"output_mcast setting ttl=%d failed: %s\n",mcast_ttl,strerror(errno));
  }
  // Ensure our local listeners get it too
  // This should already be the default
  uint8_t const loop = true;
  int r = 0;
  if(group_sock->sa_family == AF_INET)
    r = setsockopt(fd, IPPROTO_IP, IP_MULTICAST_LOOP, &loop, sizeof(loop));
  else
    r = setsockopt(fd, IPPROTO_IPV6, IPV6_MULTICAST_LOOP, &loop, sizeof(loop));
  if(r)
      fprintf(stderr,"output_mcast setting loopback=%d failed: %s\n",loop,strerror(errno));

  if(tos >= 0){
    int r = 0;
    if(group_sock->sa_family == AF_INET)
      r = setsockopt(fd, IPPROTO_IP, IP_TOS, &tos, sizeof(tos));
    else
      r = setsockopt(fd, IPPROTO_IPV6, IPV6_TCLASS, &tos, sizeof(tos));
    if(r)
    fprintf(stderr,"output_mcast setting ip tos=%d failed: %s\n",tos,strerror(errno));
  }
  /* Strictly speaking, it is not necessary to join a multicast group to which we only send.
     But this creates a problem with "smart" switches that do IGMP snooping.
     They have a setting to handle what happens with unregistered
     multicast groups (groups to which no IGMP messages are seen.)
     Discarding unregistered multicast breaks IPv6 multicast, which breaks ALL of IPv6
     because neighbor discovery uses multicast.
     It can also break IPv4 mDNS, though hardwiring 224.0.0.251 to flood can fix this.
     But if the switches are set to pass unregistered multicasts, then IPv4 multicasts
     that aren't subscribed to by anybody are flooded everywhere!
     We avoid that by subscribing to our own multicasts.
     We don't listen on output sockets so we don't need to specify SSM
  */

  if(ttl <= 0){
    // Ignore iface; listen and send on loopback
    if(iface != NULL && strlen(iface) > 0)
      fprintf(stderr,"ttl == 0; iface %s ignored\n",iface);

    (void)loopback_index(); // Also sets Loopback_name
    join_group(fd, NULL, group, Loopback_name); // no point in setting source
    // always send to loopback
    if(group_sock->sa_family == AF_INET)
      setup_ipv4_loopback(fd); // direct output to the loopback interface
    else
      setup_ipv6_loopback(fd);
  } else if(iface != NULL && strlen(iface) > 0){
    // ttl > 0 && iface explicitly specified; join and send on the requested interface
    if(join_group(fd, NULL, group, iface) == -1){ // handles both v4 and v6
      fprintf(stderr,"join group on output interface %s failed: %s",iface,strerror(errno));
    }
    // Set up output to requested interface
    // If the iface doesn't seem to exist, direct to loopback
    int if_index = if_nametoindex(iface);
    if_index = (if_index <= 0) ? loopback_index() : if_index;
    if(group_sock->sa_family == AF_INET){
      struct sockaddr_in const *sin = (struct sockaddr_in const *)group_sock;
      struct ip_mreqn mreqn = {
    .imr_address.s_addr = INADDR_ANY, // use whatever address is on the interface
    .imr_multiaddr = sin->sin_addr, // does this really need to be set?
      };
      mreqn.imr_ifindex = if_index;
      if (setsockopt(fd,  IPPROTO_IP,  IP_MULTICAST_IF, &mreqn, sizeof mreqn) < 0){
    fprintf(stderr,"set up IPv4 multicast output to iface %s failed: %s",iface,strerror(errno));
    return -1;
      }
    } else { // iface set && IPv6
      // IPv6 is actually simpler! Amazing!
      if (setsockopt(fd, IPPROTO_IPV6, IPV6_MULTICAST_IF, &if_index, sizeof if_index) < 0){
    fprintf(stderr,"set up IPv6 multicast output to iface %s failed: %s",iface,strerror(errno));
    return -1;
      }
    }
  } else {
    // ttl > 0 but iface not specified, just listen and send on default route
    if(join_group(fd, NULL, group, NULL) == -1)
      fprintf(stderr,"join group on default interface failed: %s",strerror(errno));
  }
  return fd;
}

// Like output_mcast, but also do a connect()
int connect_mcast(void const * const s, char const * const iface, int const ttl, int const tos){
  int fd = output_mcast(s, iface, ttl, tos);
  if(fd == -1)
    return -1;

  if(connect(fd, s, sizeof(struct sockaddr)) == -1){
    fprintf(stderr,"connect(socket=%s,iface=%s,ttl=%d,tos=%d) failed: %s\n",
    formatsock(s,false),iface,ttl,tos,strerror(errno));
    close(fd);
    return -1;
  }
  return fd;
}

// Create a listening socket on specified multicast address and port
// using specified interface (or default) and on loopback
// Interface may be null
// if source != NULL,  use source-specific multicast
// Assumes IPv4
int listen_mcast(void const *source, void const *group, char const *iface){
  if(group == NULL)
    return -1;

  struct sockaddr const *group_socket = group;
  int const fd = socket(group_socket->sa_family, SOCK_DGRAM, 0);
  if(fd == -1){
    fprintf(stderr,"listen_mcast(source=%s,group=%s,iface=%s) failed %s:\n",
    formatsock(source,false),formatsock(group,false),iface,strerror(errno));
    return -1;
  }
  // If source specific multicast (SSM) is in use (source != NULL), iface is
  // ignored; we must use the interface that can reach the source
  // If it's us, this will be the loopback interface
  // Otherwise if the source can't be reached we will fail
  join_group(fd, source, group_socket, iface);
  // if we're not using SSM, see if we can also join via loopback, to avoid default routing screwups
  if(source == NULL){
    (void)loopback_index(); // Sets Loopback_name
    join_group(fd, NULL, group, Loopback_name);
  }
  int const reuse = true; // bool doesn't work for some reason
  if(setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &reuse, sizeof(reuse)) != 0)
    fprintf(stderr,"listen_mcast socket set SO_REUSEPORT %d failed: %s\n",reuse,strerror(errno));
  if(setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) != 0)
    fprintf(stderr,"listen_mcast socket set SO_REUSEADDR %d failed: %s\n",reuse,strerror(errno));

#ifdef IP_FREEBIND
  int const freebind = true;
  if(setsockopt(fd, IPPROTO_IP, IP_FREEBIND, &freebind, sizeof(freebind)) != 0)
    fprintf(stderr,"listen_mcast socket set IP_FREEBIND %d failed: %s\n",freebind,strerror(errno));
#endif

  if((bind(fd, group_socket, sizeof(struct sockaddr)) != 0)){
    fprintf(stderr,"listen_mcast bind to %s failed: %s\n",formatsock(group_socket,false),strerror(errno));
    close(fd);
    return -1;
  }
  return fd;
}

// Resolve a multicast target string in the form "name[:port][,iface]"
// If "name" is not qualified (no periods) then .local will be appended by default
// If :port is not specified, port field in result will be zero
int resolve_mcast(char const *group, void *group_sock, int default_port, char *iface, int iface_len, int tries){
  if(group == NULL || strlen(group) == 0 || group_sock == NULL)
    return -1;

  char host[PATH_MAX]; // Maximum legal DNS name length?
  strlcpy(host, group, sizeof(host));

  // Look for ,iface at end of group. If present, delimit and copy to user
  char *ifp = strrchr(host, ',');
  if(ifp != NULL){
    // ,iface field found
    *ifp++ = '\0'; // Zap ',' with null to end preceding string
  }
  if(iface != NULL && iface_len > 0){
    if(ifp == NULL)
      *iface = '\0';
    else
      strlcpy(iface, ifp, iface_len);
  }
  // Look for :port
  char *port;
  if((port = strrchr(host, ':')) != NULL){
    *port++ = '\0';
  }

  struct addrinfo *results;
  int try;
  // If no domain zone is specified, assume .local (i.e., for multicast DNS)
  char full_host[PATH_MAX+6];
  if(strchr(host, '.') == NULL)
    snprintf(full_host, sizeof(full_host), "%s.local", host);
  else
    strlcpy(full_host, host, sizeof(full_host));

  int64_t start_time = gps_time_ns();
  bool message_logged = false;

  for(try=0;tries == 0 || try != tries;try++){
    results = NULL;
    struct addrinfo hints = {
      .ai_family = AF_UNSPEC,
      .ai_socktype = SOCK_DGRAM,
      .ai_protocol = IPPROTO_UDP,
      .ai_flags = AI_ADDRCONFIG,
    };

#if 1
    // Using hints.ai_family = AF_UNSPEC generates both A and AAAA queries
    // but even when the A query is answered the library times out and retransmits the AAAA
    // query several times. So do only an A (IPv4) query the first time
    if(try == 0)
      hints.ai_family = AF_INET;
#endif
    int const ecode = getaddrinfo(full_host, port, &hints, &results);
    if(ecode == 0)
      break;
    if(!message_logged){
      int64_t now = gps_time_ns();
      if(now > start_time + 2 * BILLION){
    fprintf(stderr, "resolve_mcast getaddrinfo(host=%s, port=%s): %s. Retrying.\n", full_host, port, gai_strerror(ecode));
    message_logged = true;
      }
    }
  }
  if(message_logged && try == tries){
    fprintf(stderr, "resolve_mcast getaddrinfo(host=%s, port=%s) failed\n", full_host, port);
    return -1;
  }
  if(message_logged) // Don't leave them hanging: report success after failure
    fprintf(stderr, "resolve_mcast getaddrinfo(host=%s, port=%s) succeeded\n", full_host, port);

  // Use first entry on list -- much simpler
  // I previously tried each entry in turn until one succeeded, but with UDP sockets and
  // flags set to only return supported addresses, how could any of them fail?
  memcpy(group_sock, results->ai_addr, results->ai_addrlen);
  if(port == NULL){
    // Insert default port
    setportnumber(group_sock, default_port);
  }
  freeaddrinfo(results); results = NULL;
  return 0;
}

// Convert binary sockaddr structure (v4 or v6 or unix) to printable numeric string
char *formataddr(char *result, int size, void const *sock){
  struct sockaddr const *sa = (struct sockaddr *)sock;
  result[0] = '\0';
  switch(sa->sa_family){
  case AF_INET:
    {
      struct sockaddr_in const *sin = (struct sockaddr_in *)sock;
      inet_ntop(AF_INET, &sin->sin_addr, result, size);
    }
    break;
  case AF_INET6:
    {
      struct sockaddr_in6 const *sin = (struct sockaddr_in6 *)sock;
      inet_ntop(AF_INET6, &sin->sin6_addr, result, size);
    }
    break;
  }
  return result;
}


// Convert binary sockaddr structure to printable host:port string
// cache result, as getnameinfo can be very slow when it doesn't get a reverse DNS hit

// Needs locks to be made thread safe.
// Unfortunately, getnameinfo() can be very slow (the whole reason we need a cache!)
// so we let go of the lock while it executes. That might cause duplicate entries
// if two callers look up the same unresolved name at the same time, but that doesn't
// seem likely to cause a problem?

struct inverse_cache {
  struct inverse_cache *next;
  struct inverse_cache *prev;
  struct sockaddr_storage sock;
  char hostport [2*NI_MAXHOST+NI_MAXSERV+5];
};

static struct inverse_cache *Inverse_cache_table; // Head of cache linked list

static pthread_mutex_t Formatsock_mutex = PTHREAD_MUTEX_INITIALIZER;

// We actually take a sockaddr *, but can also accept a sockaddr_in *, sockaddr_in6 * and sockaddr_storage *
// so to make it easier for callers we just take a void * and avoid pointer casts that impair readability
char const *formatsock(void const *s,bool full){
  if(s == NULL)
    return "(NULL)";
  // Determine actual length (and type) of binary socket structure (IPv4/IPv6)
  size_t slen = 0;
  struct sockaddr const * const sa = (struct sockaddr *)s;
  if(sa == NULL)
    return NULL;
  switch(sa->sa_family){
  case AF_INET:
    slen = sizeof(struct sockaddr_in);
    break;
  case AF_INET6:
    slen = sizeof(struct sockaddr_in6);
    break;
  default: // shouldn't happen unless uninitialized
    return NULL;
  }
  pthread_mutex_lock(&Formatsock_mutex);
  for(struct inverse_cache *ic = Inverse_cache_table; ic != NULL; ic = ic->next){
    if(address_match(&ic->sock, sa) && getportnumber(&ic->sock) == getportnumber(sa)){
      if(ic->prev == NULL){
    pthread_mutex_unlock(&Formatsock_mutex);
    return ic->hostport; // Already at top of list
      }
      // move to top of list so it'll be faster to find if we look for it again soon
      ic->prev->next = ic->next;
      if(ic->next)
    ic->next->prev = ic->prev;

      ic->next = Inverse_cache_table;
      ic->next->prev = ic;
      ic->prev = NULL;
      Inverse_cache_table = ic;
      pthread_mutex_unlock(&Formatsock_mutex);
      return ic->hostport;
    }
  }
  pthread_mutex_unlock(&Formatsock_mutex); // Let go of the lock, this will take a while
  // Not in list yet
  struct inverse_cache * const ic = (struct inverse_cache *)calloc(1, sizeof(*ic));
  assert(ic != NULL); // Malloc failures are rare
  char host[NI_MAXHOST] = {0}, port[NI_MAXSERV] = {0}, hostname[NI_MAXHOST] = {0};
  getnameinfo(sa, slen,
      host, NI_MAXHOST,
      port, NI_MAXSERV,
      NI_NOFQDN|NI_NUMERICHOST|NI_NUMERICSERV); // this should be fast

  // Inverse search for name of 0.0.0.0 will time out after a long time
  if(full && strcmp(host, "0.0.0.0") != 0){
    getnameinfo(sa, slen,
        hostname, NI_MAXHOST,
        NULL, 0,
        NI_NOFQDN|NI_NUMERICSERV);
  }
  if(full && strlen(hostname) > 0 && strncmp(hostname, host, sizeof(host)) != 0)
    snprintf(ic->hostport, sizeof(ic->hostport), "%s(%s):%s", host, hostname, port);
  else
    snprintf(ic->hostport, sizeof(ic->hostport), "%s:%s", host, port);

  assert(slen < sizeof(ic->sock));
  memcpy(&ic->sock, sa, slen);

  // Put at head of table
  pthread_mutex_lock(&Formatsock_mutex);
  ic->next = Inverse_cache_table;
  if(ic->next)
    ic->next->prev = ic;
  Inverse_cache_table = ic;
  pthread_mutex_unlock(&Formatsock_mutex);
  return ic->hostport;
}

// Compare IP addresses in sockaddr structures for equality
int address_match(void const *arg1, void const *arg2){
  if(arg1 == NULL || arg2 == NULL)
    return -1;
  struct sockaddr const *s1 = (struct sockaddr *)arg1;
  struct sockaddr const *s2 = (struct sockaddr *)arg2;
  if(s1->sa_family != s2->sa_family)
    return 0;

  switch(s1->sa_family){
  case AF_INET:
    {
      struct sockaddr_in const *sinp1 = (struct sockaddr_in *)arg1;
      struct sockaddr_in const *sinp2 = (struct sockaddr_in *)arg2;
      if(memcmp(&sinp1->sin_addr, &sinp2->sin_addr, sizeof(sinp1->sin_addr)) == 0)
    return 1;
    }
    break;
  case AF_INET6:
    {
      struct sockaddr_in6 const *sinp1 = (struct sockaddr_in6 *)arg1;
      struct sockaddr_in6 const *sinp2 = (struct sockaddr_in6 *)arg2;
      if(memcmp(&sinp1->sin6_addr, &sinp2->sin6_addr, sizeof(sinp1->sin6_addr)) == 0)
    return 1;
    }
    break;
  }
  return 0;
}

// Return port number (in HOST order) in a sockaddr structure
// Return -1 on error
int getportnumber(void const *arg){
  if(arg == NULL)
    return -1;
  struct sockaddr const *sock = (struct sockaddr *)arg;

  switch(sock->sa_family){
  case AF_INET:
    {
      struct sockaddr_in const *sin = (struct sockaddr_in *)sock;
      return ntohs(sin->sin_port);
    }
    break;
  case AF_INET6:
    {
      struct sockaddr_in6 const *sin6 = (struct sockaddr_in6 *)sock;
      return ntohs(sin6->sin6_port);
    }
    break;
  default:
    return -1;
  }
}

// Set the port number on a sockaddr structure
// Port number argument is in HOST order
int setportnumber(void *s, uint16_t port){
  if(s == NULL)
    return -1;
  struct sockaddr *sock = (struct sockaddr *)s;

  switch(sock->sa_family){
  case AF_INET:
    {
      struct sockaddr_in *sin = (struct sockaddr_in *)sock;
      sin->sin_port = htons(port);
    }
    break;
  case AF_INET6:
    {
      struct sockaddr_in6 *sin6 = (struct sockaddr_in6 *)sock;
      sin6->sin6_port = htons(port);
    }
    break;
  default:
    return -1;
  }
  return 0;
}

// Get the name and index of the loopback interface
// Try to set multicast flag,  though this requires network admin privileges
static int loopback_index(void){
  if(Loopback_index > 0)
    return Loopback_index;

  // One-time setup of loopback
  // Instead of hardwiring the loopback name (which can vary) find it in the system's list
  struct ifaddrs *ifap = NULL;
  if(getifaddrs(&ifap) != 0){
    fprintf(stderr,"No loopback interface found! We really need it...\n");
    exit(EX_OSFILE);
  }
  struct ifaddrs const *lop = NULL;
  for(lop = ifap; lop != NULL; lop = lop->ifa_next)
    if(lop->ifa_name && (lop->ifa_flags & IFF_LOOPBACK))
      break;

  if(lop == NULL){
    freeifaddrs(ifap);
    fprintf(stderr,"No loopback interface found! We really need it...\n");
    exit(EX_OSFILE); // This is pretty serious
  }
  {
    size_t r = strlcpy(Loopback_name, lop->ifa_name, sizeof Loopback_name);
    (void)r;
    assert(r < sizeof Loopback_name);
  }
  Loopback_index = if_nametoindex(lop->ifa_name);
  assert(Loopback_index > 0);
  if(lop->ifa_flags & IFF_MULTICAST){
    freeifaddrs(ifap);
    return Loopback_index; // Already set
  }
  // We need multicast enabled on the loopback interface
  struct ifreq ifr = {
    .ifr_flags = lop->ifa_flags | IFF_MULTICAST
  };
  strlcpy(ifr.ifr_name, Loopback_name, sizeof(ifr.ifr_name));

  freeifaddrs(ifap);
  ifap = NULL;
  lop = NULL;
  int fd = socket(AF_INET, SOCK_DGRAM, 0); // Same for IPv6?
  int const r = ioctl(fd,  SIOCSIFFLAGS,  &ifr);
  if(r < 0){
    // Given how much we rely on multicast loopback, make this fatal
    fprintf(stderr, "Can't enable multicast option on loopback interface %s: %s\n", ifr.ifr_name,strerror(errno));
    fprintf(stderr, "Set manually (on Linux) with 'sudo ip link set dev %s multicast on' or 'sudo systemctl start set_lo_multicast'\n",Loopback_name);
    close(fd);
    exit(EX_NOPERM);
  }
  close(fd);
  fprintf(stderr, "Multicast enabled on loopback interface %s\n", Loopback_name);
#if __linux__
  // This capability is set when radiod is run by systemd, drop it when we no longer need it
  if (prctl(PR_CAP_AMBIENT_LOWER,  CAP_NET_ADMIN,  0,  0,  0) == 0)
    fprintf(stderr,"Dropped CAP_NET_ADMIN capability\n");
  else
    fprintf(stderr,"Can't drop CAP_NET_ADMIN capability: %s\n",strerror(errno));
#endif
  return Loopback_index;
}

// Join an existing socket to a multicast group without connecting it
// Since many channels may send to the same multicast group, the joins can often fail with harmless "address already in use" messages
// Note: only the IP address is significant, the port number is ignored
int join_group(int fd, struct sockaddr const * const source, struct sockaddr const * const group,  char const * const iface){
  if(fd == -1 || group == NULL){
    errno = EINVAL;
    return -1;
  }
  if(!is_multicast(group)){
    errno = EINVAL;
    return -1;
  }
  if(source != NULL)
    return ssm_join_group(fd,source,group,iface); // IPv4 and v6 have different SSM calls

  // set up for protocol-independent any-source join
  struct group_req req = {0};
  int level = 0;

  switch(group->sa_family){
  case AF_INET:
    {
      level = IPPROTO_IP;
      memcpy(&req.gr_group,group,sizeof(struct sockaddr_in));
    }
    break;
  case AF_INET6:
    {
      level = IPPROTO_IPV6;
      memcpy(&req.gr_group,group,sizeof(struct sockaddr_in6));
    }
    break;
  default:
    errno = EAFNOSUPPORT; // won't actually get here, is_multicast() will get it first
    return -1; // Unknown protocol family
  }
  // Get interface index
  // I wish everybody was consistent with signed/unsigned index values
  // The actual value is unsigned, and 0 means "unspecified", not a real interface
  // if_nametoindex() returns unsigned
  // get_interface_index_for_destination() returns -1 for some errors
  // So always check for returns!
  int if_index = 0;
  if(iface != NULL && strlen(iface) > 0)
    if_index = if_nametoindex(iface);
  else
    if_index = get_interface_index_for_destination(group);

  req.gr_interface = (if_index <= 0) ? loopback_index() : if_index; // fall back to loopback
  if(setsockopt(fd, level, MCAST_JOIN_GROUP, &req, sizeof req) < 0){
    if(errno != EADDRINUSE) // not a fatal error, happens routinely
      fprintf(stderr,"setsockopt(%d, %s, MCAST_JOIN_GROUP, %s iface=%s) failed: %s\n",
        fd, level == IPPROTO_IP ? "IPPROTO_IP" : "IPPROTO_IPV6",
        formatsock(group,false), iface,
        strerror(errno));
    return -1;
  }
  return 0;
}

// Join a socket to a source specific multicast group on specified iface,  or default if NULL
static int ssm_join_group(int const fd, struct sockaddr const *source, struct sockaddr const *group, char const * const iface){
  assert(source != NULL && group != NULL);
  if(group->sa_family == AF_INET){
    struct sockaddr_in const * const group_sin = (struct sockaddr_in const *)group;
    // Source-specific multicast, must be to interface we use to reach the source
    // Should find the loopback interface if we're the source we're looking for
    // I think we're only allowed one join to one interface
    struct sockaddr_in const * const source_sin = (struct sockaddr_in *)source;
    struct ip_mreq_source const mreqn = {
      .imr_multiaddr = group_sin->sin_addr,
      .imr_sourceaddr = source_sin->sin_addr,
      .imr_interface.s_addr = get_local_address_for(source_sin->sin_addr.s_addr),
    };
    if(mreqn.imr_interface.s_addr == 0 || mreqn.imr_interface.s_addr == INADDR_NONE){
      fprintf(stderr,"Can't find local interface that reaches %s\n",formatsock(source,false));
      return -1;
    }
#if 0
    char localbuf[INET_ADDRSTRLEN];
    char sourcebuf[INET_ADDRSTRLEN];
    char groupbuf[INET_ADDRSTRLEN];

    inet_ntop(AF_INET, &mreqn.imr_interface, localbuf, sizeof(localbuf));
    inet_ntop(AF_INET, &mreqn.imr_sourceaddr, sourcebuf, sizeof(sourcebuf));
    inet_ntop(AF_INET, &mreqn.imr_multiaddr, groupbuf, sizeof(groupbuf));

    fprintf(stderr, "JOIN: fd %d  group %s source %s via local %s\n", fd, groupbuf, sourcebuf, localbuf);
#endif
    if(setsockopt(fd, IPPROTO_IP, IP_ADD_SOURCE_MEMBERSHIP, &mreqn, sizeof(mreqn)) != 0 && errno != EADDRINUSE){
      fprintf(stderr, "source-specific join IPv4 %s from source %s on iface addr %s failed: %s\n",
          formatsock(group, false),
          formatsock(source, false),
          formatsock(source_sin, false), // iface is ignored, we must use the interface that reaches the source
          strerror(errno));
      return -1;
    }
  } else if(group->sa_family == AF_INET6){
    // Untested
    int if_index = 0;
    if(iface != NULL && strlen(iface) > 0)
      if_index = if_nametoindex(iface);
    else
      if_index = get_interface_index_for_destination(source);

    if(if_index < 1) // either 0 or -1
      if_index = loopback_index(); // Probably won't work but try it anyway

    struct group_source_req gsreq = {
      .gsr_interface = if_index
    };
    memcpy(&gsreq.gsr_source, source, sizeof(struct sockaddr_in6));
    memcpy(&gsreq.gsr_group, group,  sizeof(struct sockaddr_in6));
    if(setsockopt(fd, IPPROTO_IPV6, MCAST_JOIN_SOURCE_GROUP, &gsreq, sizeof gsreq) < 0){
      char name[IFNAMSIZ];
      fprintf(stderr, "join IPv6 group %s source %s on %s (%s) failed: %s\n",
          formatsock(group, false),
          formatsock(source,false),
          iface ? iface : "default",
          if_indextoname(gsreq.gsr_interface, name),
          strerror(errno));
      return -1;
    }
  } else {
    return -1; // unknown address family
  }
  return 0; // Successful
}

// Direct outbound multicasts to loopback, e.g., when TTL = 0 or operating standalone
// Are both IPv4 and IPv6 versions necessary?
static int setup_ipv4_loopback(int fd){
  int lo_index = loopback_index();

  if(lo_index <= 0){
    fprintf(stderr, "Can't find loopback interface\n");
    return -1;
  }
  struct ip_mreqn const mreqn = {
    .imr_address.s_addr = htonl(INADDR_LOOPBACK),
    .imr_ifindex = lo_index,
  };
  if (setsockopt(fd,  IPPROTO_IP,  IP_MULTICAST_IF, &mreqn, sizeof mreqn) < 0){
    fprintf(stderr,"setup_ipv4_loopback(%d) IP_MULTICAST_IF failed: %s\n",fd,strerror(errno));
    return -1;
  }
  return 0;
}

static int setup_ipv6_loopback(int fd){
  int lo_index = loopback_index();

  if(lo_index <= 0){
    fprintf(stderr, "Can't find loopback interface\n");
    return -1;
  }
  if (setsockopt(fd, IPPROTO_IPV6, IPV6_MULTICAST_IF, &lo_index, sizeof lo_index) < 0){
    fprintf(stderr,"setup_ipv6_loopback(%d) IPV6_MULTICAST_IF failed: %s\n",fd,strerror(errno));
    return -1;
  }
  return 0;
}

// Generate a multicast address in the 239.0.0.0/8 administratively scoped block
// avoiding 239.0.0.0/24 and 239.128.0.0/24 since these map at the link layer
// into the same Ethernet multicast MAC addresses as the 224.0.0.0/8 multicast control block
// that is not snooped by switches
uint32_t make_maddr(char const *arg){
  //  uint32_t addr = (239U << 24) | (ElfHashString(arg) & 0xffffff); // poor performance when last byte is always the same (.)
  uint32_t addr = (239U << 24) | (fnv1hash((uint8_t *)arg, strlen(arg)) & 0xffffff);
  // avoid 239.0.0.0/24 and 239.128.0.0/24 since they map to the same
  // Ethernet multicast MAC addresses as 224.0.0.0/24, the internet control block
  // This increases the risk of collision slightly (512 out of 16 M)
  if((addr & 0x007fff00) == 0)
    addr |= (addr & 0xff) << 8;
  if((addr & 0x007fff00) == 0)
    addr |= 0x00100000; // Small chance of this for a random address
  return addr;
}
// Returns local IPv4 address as uint32_t (network byte order) that would be used to reach dest
// Written by ChatGPT, and surprisingly it works
static uint32_t get_local_address_for(uint32_t dest_addr) {
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0)
        return INADDR_NONE;

    struct sockaddr_in const dest = {
      .sin_family = AF_INET,
      .sin_port = 1, // arbitrary port, doesn't matter
      .sin_addr.s_addr = dest_addr,
    };
    // connect() will NOT send packets, but will bind socket to local interface
    if (connect(sock, (struct sockaddr *)&dest, sizeof(dest)) < 0) {
        close(sock);
        return INADDR_NONE;
    }
    struct sockaddr_in local = {0};
    socklen_t len = sizeof(local);
    if (getsockname(sock, (struct sockaddr *)&local, &len) < 0) {
        close(sock);
        return INADDR_NONE;
    }

    close(sock);
    return local.sin_addr.s_addr; // Already in network byte order
}
// Set the port field in a socket structure
int setport(void *sock,int port){
  struct sockaddr_storage *ss = (struct sockaddr_storage *)sock;
  switch(ss->ss_family){
  case AF_INET:
    {
      struct sockaddr_in *sin = (struct sockaddr_in *)ss;
      sin->sin_port = htons(port);
    }
    break;
  case AF_INET6:
    {
      struct sockaddr_in6 *sin6 = (struct sockaddr_in6 *)ss;
      sin6->sin6_port = htons(port);
    }
    break;
  default:
    return -1; // Unknown address family
  }
  return 0;
}


static int get_interface_index_for_destination(struct sockaddr const *dest) {
  int sock = socket(dest->sa_family, SOCK_DGRAM, 0);
  if (sock < 0)
    return -1;

  // Try connecting — this picks the outbound interface
  socklen_t len = dest->sa_family == AF_INET ? sizeof(struct sockaddr_in) : sizeof(struct sockaddr_in6);
  if(connect(sock, dest, len) != 0){
    close(sock);
    return -1;
  }
  // Ask kernel what local address it chose
  struct sockaddr_storage local_addr = {0};
  if (getsockname(sock, (struct sockaddr *)&local_addr, &len) != 0) {
    close(sock);
    return -1;
  }
  close(sock);
  return iface_index_from_address((struct sockaddr *)&local_addr);
}

// Map local interface address back to an interface index
// Should this return -1 on errors? the actual index is unsigned
// Just be careful to always check for error returns
static int iface_index_from_address(struct sockaddr const *addr){
  struct ifaddrs *ifa = NULL;
  if (getifaddrs(&ifa) != 0)
    return -1;

  int index = -1;
  for(struct ifaddrs const *p = ifa; p != NULL; p = p->ifa_next) {
    if(p->ifa_addr == NULL)
      continue;
    if(p->ifa_addr->sa_family != addr->sa_family)
      continue;

    switch(addr->sa_family){
    case AF_INET:
      {
    struct sockaddr_in const *b = (struct sockaddr_in *)addr;
    struct sockaddr_in const *a = (struct sockaddr_in *)p->ifa_addr;
    if(memcmp(&a->sin_addr, &b->sin_addr, sizeof(struct in_addr)) == 0){
      index = if_nametoindex(p->ifa_name);
      goto done;
    }
      }
      break;
    case AF_INET6:
      {
    struct sockaddr_in6 const *b = (struct sockaddr_in6 *)addr;
    struct sockaddr_in6 const *a = (struct sockaddr_in6 *)p->ifa_addr;
    if(IN6_IS_ADDR_LINKLOCAL(&a->sin6_addr) && a->sin6_scope_id != b->sin6_scope_id)
      continue;

    if(memcmp(&a->sin6_addr, &b->sin6_addr, sizeof(struct in6_addr)) == 0){
      index = if_nametoindex(p->ifa_name);
      goto done;
    }
      }
      break;
    default:
      break;
    }
  }
 done:;
  freeifaddrs(ifa);
  return index;
}
bool is_multicast(struct sockaddr const *group){
  // Validate that group is actually a multicast address
  switch(group->sa_family){
  case AF_INET:
    {
      struct sockaddr_in const * const sin = (struct sockaddr_in *)group;
      if(IN_MULTICAST(ntohl(sin->sin_addr.s_addr))){
    return true;
      }
    }
    break;
  case AF_INET6:
    {
      struct sockaddr_in6 const * const sin6 = (struct sockaddr_in6 *)group;
      if(IN6_IS_ADDR_MULTICAST(&sin6->sin6_addr)){
    return true;
      }
    }
    break;
  default:
    return false;
  }
  return false;
}
