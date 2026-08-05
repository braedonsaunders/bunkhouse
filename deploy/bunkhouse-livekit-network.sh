#!/bin/sh
#
# Reconcile the host rules needed by LiveKit's published media and TURN ports
# on Docker Swarm. This script is idempotent and intentionally touches only
# Bunkhouse's ports and its own legacy iptables chains.

set -eu

STACK_NAME=${BUNKHOUSE_STACK_NAME:-compose-calculate-primary-firewall-7sxxl5}
NODE_IP=${LIVEKIT_NODE_IP:-10.0.0.101}
LIVEKIT_SERVICE="${STACK_NAME}_livekit"

container_id=$(docker ps --filter "label=com.docker.swarm.service.name=${LIVEKIT_SERVICE}" --format '{{.ID}}' | head -1)

# A task replacement is normal during a deploy. The timer will retry as soon
# as the replacement container is running.
[ -n "${container_id}" ] || exit 0

task_pid=$(docker inspect "${container_id}" --format '{{.State.Pid}}')
[ -n "${task_pid}" ] || exit 0

# LiveKit now substitutes its service VIP into the config before it starts,
# so the SFU and embedded TURN server communicate directly on the overlay.
# Remove the older LAN-address alias and hairpin chains when upgrading.
nsenter -t "${task_pid}" -n ip address del "${NODE_IP}/32" dev lo 2>/dev/null || true
while nsenter -t "${task_pid}" -n iptables -t nat -C OUTPUT -j BUNKHOUSE_MEDIA 2>/dev/null; do
  nsenter -t "${task_pid}" -n iptables -t nat -D OUTPUT -j BUNKHOUSE_MEDIA
done
nsenter -t "${task_pid}" -n iptables -t nat -F BUNKHOUSE_MEDIA 2>/dev/null || true
nsenter -t "${task_pid}" -n iptables -t nat -X BUNKHOUSE_MEDIA 2>/dev/null || true
while nsenter -t "${task_pid}" -n iptables -t nat -C POSTROUTING -j BUNKHOUSE_MEDIA_POST 2>/dev/null; do
  nsenter -t "${task_pid}" -n iptables -t nat -D POSTROUTING -j BUNKHOUSE_MEDIA_POST
done
nsenter -t "${task_pid}" -n iptables -t nat -F BUNKHOUSE_MEDIA_POST 2>/dev/null || true
nsenter -t "${task_pid}" -n iptables -t nat -X BUNKHOUSE_MEDIA_POST 2>/dev/null || true

bridge_cidr=$(ip -o -4 addr show docker_gwbridge | awk 'NR == 1 { split($4, address, "/"); split(address[1], octet, "."); print octet[1] "." octet[2] ".0.0/16" }')

# Docker DNATs host-published sockets into docker_gwbridge. Without source NAT,
# replies follow the overlapping overlay route instead of returning to the
# real client/edge peer.
ensure_masquerade() {
  protocol=$1
  destination_port=$2
  original_port=$3
  iptables -t nat -C POSTROUTING -p "${protocol}" -d "${bridge_cidr}" --dport "${destination_port}" -m conntrack --ctorigdstport "${original_port}" -j MASQUERADE 2>/dev/null || iptables -t nat -I POSTROUTING 1 -p "${protocol}" -d "${bridge_cidr}" --dport "${destination_port}" -m conntrack --ctorigdstport "${original_port}" -j MASQUERADE
}

ensure_masquerade tcp 443 5349
ensure_masquerade tcp 7881 7881
ensure_masquerade udp 7882 7882

# Remove the former host-side source rewrite. External clients use the public
# TURN/TLS endpoint; relayed peer traffic never needs to leave the overlay.
while iptables -t nat -C POSTROUTING -j BUNKHOUSE_MEDIA 2>/dev/null; do
  iptables -t nat -D POSTROUTING -j BUNKHOUSE_MEDIA
done
iptables -t nat -F BUNKHOUSE_MEDIA 2>/dev/null || true
iptables -t nat -X BUNKHOUSE_MEDIA 2>/dev/null || true
