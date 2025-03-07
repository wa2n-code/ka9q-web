# ka9q-web

A web interface for ka9q-radio by John Melton G0ORX


## How to build ka9q-web

### 1 - Build and install ka9q-radio

- `git clone https://github.com/ka9q/ka9q-radio.git`
- detailed instructions are here: https://github.com/ka9q/ka9q-radio/blob/main/docs/INSTALL.md


### 2 - Install the prerequisites for the Onion framework: GnuTLS and libgcrypto

The Onion framework requires GnuTLS and libgcrypto to compute the SHA1 checksum required by WebSockets.
They can be installed as follows:

- on Ubuntu 22.04 (Jammy Jellyfish) and Ubuntu 24.04 (Noble Numbat):
```
sudo apt install libgnutls28-dev libgcrypt20-dev
```

- on Debian Stable (12, bookworm)  and similar Linux distributions:
```
sudo apt install libgnutls28-dev libgcrypt-dev
```

- on RedHat, CentOS, Fedora and similar Linux distributions:
```
sudo dnf install gnutls-devel libgcrypt-devel
```


### 3 - Build and install the Onion framework

The Orion framework includes a lot of dependencies (like sqlite3, redis, etc) that are not needed just to run ka9q-web. The instructions below build the Onion framework with all the dependencies. See section 3A for instructions to build a lighter version of the Onion framework with only the few necessary dependencies.

```
git clone https://github.com/davidmoreno/onion
cd onion
mkdir build
cd build
cmake ..
```

Before going ahead with the next steps, do make sure that the output from 'cmake' contains the line:
> -- SSL support is compiled in.

If you don't see it, please review the instructions about the prerequisites for the Onion framework in the previous section.

```
make
sudo make install
sudo ldconfig
```

### 3A - Build and install a light version of the Onion framework

These commands are almost identical to the ones in the section above except that all the unused features of the Onion framework are disabled to limit the number of dependencies and other packages.

```
git clone https://github.com/davidmoreno/onion
cd onion
mkdir build
cd build
cmake -DONION_USE_PAM=false -DONION_USE_PNG=false -DONION_USE_JPEG=false -DONION_USE_XML2=false -DONION_USE_SYSTEMD=false -DONION_USE_SQLITE3=false -DONION_USE_REDIS=false -DONION_USE_GC=false -DONION_USE_TESTS=false -DONION_EXAMPLES=false -DONION_USE_BINDINGS_CPP=false ..
```

Before going ahead with the next steps, do make sure that the output from 'cmake' contains the line:
> -- SSL support is compiled in.

If you don't see it, please review the instructions about the prerequisites for the Onion framework in the previous section.

```
make
sudo make install
sudo ldconfig
```

### 4 - Build and install ka9q-web

 - cd ~

- `git clone https://github.com/scottnewell/ka9q-web.git`

- cd ka9q-web

- edit the first line of `Makefile` to point to the directory where you built ka9q-radio
- run:
```
make
sudo make install
sudo make install-config    (it will install rx888-web.conf in /etc/radio)
```


## How to run ka9q-web

1. make sure ka9q-radio is running using the configuration rx888-web:
```
sudo systemctl start radiod@rx888-web
systemctl status radiod@rx888-web
```
Address any problem with radiod before going to the next step

2. start ka9q-web
```
ka9q-web
```

Finally open a browser and connect locally to http://localhost:8081 , or from a remote browser to http://<your computer name/IP>:8081

NOTE: to start ka9q-web on a different ka9q-radio control address, the command line option is '-m', for instance:
```
ka9q-web -m hf.local
```

3. Optional feature - new Modes

ka9q-web now includes the ability to change parameters for a demodulation mode including high and low filter settings among several others. New "modes" can be created via editble text in the file presets.conf located in the /usr/local/share/ka9q-radio directory. This presets.conf file is originally created when installing ka9q-radio and it includes several predefined presets that are identified by a heading tag in square brackets such as [usb], [lsb], [am], [fm] etc. 

ka9q-web has five additional modes that can be employed via the drop-down mode selector. Each mode must have a matching tag in the presets.conf file. The new modes are [wusb], [wlsb], [user1], [user2], and [user3]. None of these modes will work if the matching preset tag is not defined in presets.conf, but no harm will come if you select them.

The easiest way to create a new mode configuration is to edit the presets.conf file and copy / paste an existing mode, then change the ID tag and whatever parameter you want changed below the new ID tag. As an example, here is a preset that matches the "WUSB" mode that widens the high-side filter edge to 3,500 Hz:

[wusb]
demod = linear
samprate = 12k
low =  +50.0
high = +3.5k
pll = no
square = no
mono = yes
shift = 0
envelope = no
conj = no
hang-time = 1.1
recovery-rate = 20

The line that is different from the original [usb] mode here is high = +3.5k, which has been changed from high = +3k.  Note that the new mode's ID tag must be in lower case, and must also match the letters from the upper case letters that show the ka9q-web mode drop down selector button list.


## References

- [John Melton G0ORX fork of ka9q-radio](https://github.com/g0orx/ka9q-radio)
- [Phil Karn KA9Q ka9q-radio](https://github.com/ka9q/ka9q-radio)

## Copyright

(C) 2023-2025 John Melton G0ORX - Licensed under the GNU GPL V3 (see [LICENSE](LICENSE))
