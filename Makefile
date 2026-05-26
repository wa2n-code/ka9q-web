PREFIX=/usr/local

# for production
DOPTS=-DNDEBUG=1 -O3

# for debugging
#DOPTS=-g

COPTS=-march=native -std=gnu11 -pthread -Wall -funsafe-math-optimizations -D_GNU_SOURCE=1

KA9QOBJS = misc.o multicast.o rtp.o status.o decode_status.o
INCLUDES=

RESOURCES_BASE_DIR=$(PREFIX)/share/ka9q-web

CFLAGS=$(DOPTS) $(COPTS)
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || printf "unknown")
GIT_COMMIT_INDEX := $(shell git rev-list --count HEAD 2>/dev/null || printf "unknown")
CPPFLAGS=$(INCLUDES) -DRESOURCES_BASE_DIR=$(RESOURCES_BASE_DIR) -DPKGDATADIR=\"$(RESOURCES_BASE_DIR)\" -DGIT_COMMIT=\"$(GIT_COMMIT)\" -DGIT_COMMIT_INDEX=\"$(GIT_COMMIT_INDEX)\"

KA9Q_RADIO_OBJS=$(KA9QOBJS)

all: ka9q-web

ka9q-web: ka9q-web.o $(KA9Q_RADIO_OBJS)
	$(CC) -o $@ $^ -lonion -lbsd -lm -ldl

# Generate config paths header (copied from ka9q-web1 Makefile)
esc = sed 's/\\/\\\\/g; s/"/\\"/g'
config_paths.h: Makefile
	echo "make $@"
	@printf '#ifndef _CONFIG_PATHS_H\n' > $@
	@printf '#define _CONFIG_PATHS_H 1\n' >> $@
	@printf '#define CONFDIR "%s"\n' '$(PREFIX)/etc/radio' >> $@
	@printf '#define STATEDIR "%s"\n' '$(PREFIX)/var/lib/ka9q-radio' >> $@
	@printf '#define PKGDATADIR "%s"\n' '$(RESOURCES_BASE_DIR)' >> $@
	@printf '#define PKGLIBDIR "%s"\n' '$(PREFIX)/lib/ka9q-web' >> $@
	@printf '#define GIT_HASH "%s"\n' "$$(git rev-parse HEAD | $(esc))" >> $@
	@printf '#define GIT_TIME "%s"\n' "$$(git show -s --format=%ci | $(esc))" >> $@
	@printf '#define GIT_BRANCH "%s"\n' "$$(git log --pretty=format:%d -n 1 | $(esc))" >> $@
	@printf '#define GIT_SUMMARY "%s"\n' "$$(git log -1 --format=%s | $(esc))" >> $@
	@printf '#define GIT_VERSION "%s"\n' "$$(git describe --always --dirty --tags | $(esc))" >> $@
	@printf '#define GIT_REMOTE_URL "%s"\n' "$$(git remote get-url origin  | $(esc))" >> $@
	@printf '#define GIT_COMMIT_INDEX "%s"\n' "$$(git rev-list --count HEAD | $(esc))" >> $@
	@printf '#endif\n' >> $@

%.o: %.c config_paths.h
	$(CC) $(CPPFLAGS) $(CFLAGS) -c -o $@ $<

install: ka9q-web
	install -m 755 $^ $(PREFIX)/sbin
	install -m 644 -D html/* -t $(RESOURCES_BASE_DIR)/html/

install-config:
	install -b -m 644 config/* /etc/radio

clean:
	-rm -f ka9q-web *.o *.d

.PHONY: clean all install
