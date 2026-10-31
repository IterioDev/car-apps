#!/bin/sh
# Build tailscaled for the head unit: static linux/amd64, userspace networking (netstack), the CLI linked in
# (ts runs it with TS_BE_CLI=1), everything the unit doesn't need left out (Tailscale's featuretags --min).
#   sh apps/iteriodev-tailscale/build.sh        (Git Bash; Go on the PATH fetches the toolchain go.mod asks for)
# -> apps/iteriodev-tailscale/tailscaled + LICENSE, and runas/runas (our uid drop). V must match component.json.
set -e
S=$(cd "$(dirname "$0")" && pwd)
(cd "$S/runas" && GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o runas .)
V=${V:-1.104.4}
SRC=${SRC:-$S/build/src}
FEATURES=cli,netstack,nattraversal,udptransport,ipnbus,health,qrcodes,dnsresolvecache,bakedroots
[ -d "$SRC/.git" ] || git clone -q --depth 1 --branch "v$V" https://github.com/tailscale/tailscale.git "$SRC"
cd "$SRC"
[ "$(cat VERSION.txt)" = "$V" ] || { echo "source is $(cat VERSION.txt), want $V (delete $SRC)"; exit 1; }
TAGS=$(GOOS= GOARCH= go run ./cmd/featuretags --min --add=$FEATURES)
eval "$(CGO_ENABLED=0 GOOS= GOARCH= go run ./cmd/mkversion)"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags="$TAGS" -trimpath \
    -ldflags "-s -w -X tailscale.com/version.longStamp=$VERSION_LONG -X tailscale.com/version.shortStamp=$VERSION_SHORT" \
    -o "$S/tailscaled" ./cmd/tailscaled
cp LICENSE "$S/LICENSE"
echo "tailscaled $VERSION_LONG: $(wc -c < "$S/tailscaled") bytes"
