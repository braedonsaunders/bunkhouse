#!/bin/sh
#
# Reconcile the host and task-network rules needed by LiveKit's embedded TURN
# server on Docker Swarm. The physical LAN and Swarm overlay both use 10.0.0.0
# space, so the SFU cannot hairpin to the host-published relay sockets without
# an explicit host route and namespace-local DNAT. This script is idempotent
# and intentionally touches only Bunkhouse's ports and its own iptables chain.

set -eu

STACK_NAME=${BUNKHOUSE_STACK_NAME:-compose-calculate-primary-firewall-7sxxl5}
NODE_IP=${LIVEKIT_NODE_IP:-10.0.0.101}
LIVEKIT_SERVICE="${STACK_NAME}_livekit"
RELAY_START=30000
RELAY_END=30049

container_id=$(docker ps --filter "label=com.docker.swarm.service.name=${LIVEKIT_SERVICE}" --format '{{.ID}}' | head -1)

# A task replacement is normal during a deploy. The timer will retry as soon
# as the replacement container is running.
[ -n "${container_id}" ] || exit 0

task_pid=$(docker inspect "${container_id}" --format '{{.State.Pid}}')
media_ip=$(docker inspect "${container_id}" | jq -r '.[0].NetworkSettings.Networks
    | to_entries[]
    | select(.key | endswith("_default"))
    | .value.IPAddress' | head -1)

[ -n "${task_pid}" ] || exit 0
[ -n "${media_ip}" ] || exit 0

# docker_gwbridge is the task's path back to the node namespace. The /32 route
# wins over the overlapping overlay route only for this manager's real LAN IP.
default_route=$(nsenter -t "${task_pid}" -n ip route show default)
gateway=$(printf '%s\n' "${default_route}" | awk '{ print $3 }')
device=$(printf '%s\n' "${default_route}" | awk '{ print $5 }')
nsenter -t "${task_pid}" -n ip route replace "${NODE_IP}/32" via "${gateway}" dev "${device}"

# Keep the two hairpin directions inside the LiveKit task namespace. A custom
# chain prevents duplicate rules when the timer runs and disappears naturally
# with the container namespace when Swarm replaces the task.
nsenter -t "${task_pid}" -n iptables -t nat -N BUNKHOUSE_MEDIA 2>/dev/null || true
nsenter -t "${task_pid}" -n iptables -t nat -C OUTPUT -j BUNKHOUSE_MEDIA 2>/dev/null || nsenter -t "${task_pid}" -n iptables -t nat -I OUTPUT 1 -j BUNKHOUSE_MEDIA
nsenter -t "${task_pid}" -n iptables -t nat -C BUNKHOUSE_MEDIA -d "${NODE_IP}" -p udp --sport 7882 --dport "${RELAY_START}:${RELAY_END}" -j DNAT --to-destination "${media_ip}" 2>/dev/null || nsenter -t "${task_pid}" -n iptables -t nat -A BUNKHOUSE_MEDIA -d "${NODE_IP}" -p udp --sport 7882 --dport "${RELAY_START}:${RELAY_END}" -j DNAT --to-destination "${media_ip}"
nsenter -t "${task_pid}" -n iptables -t nat -C BUNKHOUSE_MEDIA -d "${NODE_IP}" -p udp --sport "${RELAY_START}:${RELAY_END}" --dport 7882 -j DNAT --to-destination "${media_ip}" 2>/dev/null || nsenter -t "${task_pid}" -n iptables -t nat -A BUNKHOUSE_MEDIA -d "${NODE_IP}" -p udp --sport "${RELAY_START}:${RELAY_END}" --dport 7882 -j DNAT --to-destination "${media_ip}"

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

# Give direct SFU UDP replies the manager's real LAN source address. Keep this
# in a named chain so a task replacement removes the stale overlay source.
uplink=$(ip route get 1.1.1.1 | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == "dev") print $(i + 1) }')
iptables -t nat -N BUNKHOUSE_MEDIA 2>/dev/null || true
iptables -t nat -C POSTROUTING -j BUNKHOUSE_MEDIA 2>/dev/null || iptables -t nat -I POSTROUTING 1 -j BUNKHOUSE_MEDIA
if ! iptables -t nat -C BUNKHOUSE_MEDIA -s "${media_ip}/32" -o "${uplink}" -p udp --sport 7882 -j SNAT --to-source "${NODE_IP}" 2>/dev/null; then
  iptables -t nat -F BUNKHOUSE_MEDIA
  iptables -t nat -A BUNKHOUSE_MEDIA -s "${media_ip}/32" -o "${uplink}" -p udp --sport 7882 -j SNAT --to-source "${NODE_IP}"
fi
