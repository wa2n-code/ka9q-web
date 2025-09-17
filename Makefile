KA9Q_RADIO_DIR=../ka9q-radio/src
PREFIX=/usr/local

# for production
DOPTS=-DNDEBUG=1 -O3

# for debugging
#DOPTS=-g

COPTS=-march=native -std=gnu11 -pthread -Wall -funsafe-math-optimizations -D_GNU_SOURCE=1

INCLUDES=-I.

RESOURCES_BASE_DIR=$(PREFIX)/share/ka9q-web

CFLAGS=$(DOPTS) $(COPTS)
CPPFLAGS=$(INCLUDES) -DRESOURCES_BASE_DIR=$(RESOURCES_BASE_DIR)

# Use the bundled ka9q-radio sources instead of external objects
KA9Q_RADIO_OBJS=misc.o multicast.o rtp.o status.o decode_status.o

all: ka9q-web

ka9q-web: ka9q-web.o $(KA9Q_RADIO_OBJS)
	$(CC) -o $@ $^ -lonion -lbsd -lm

install: ka9q-web
	install -m 755 $^ $(PREFIX)/sbin
	install -m 644 -D html/* -t $(RESOURCES_BASE_DIR)/html/

install-config:
	install -b -m 644 config/* /etc/radio

clean:
	-rm -f ka9q-web *.o *.d

.PHONY: clean all install
