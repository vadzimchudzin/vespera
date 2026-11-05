#!/bin/bash
# Paper-only research bots (no keys, no orders): latency-arb paper bot + LP rewards paper sim (10 s re-quote, top-300 universe).
# Needs Node >= 22 (global WebSocket/fetch). Usage: ./run.sh start | stop | status | report
cd "$(dirname "$0")"
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
case "$1" in
  start)
    mkdir -p out lpout
    [ -f lpout/universe.json ] || node lp_universe.js lpout/universe.json 300 || exit 1
    alive out/pid || { setsid nohup node latbot.js out < /dev/null > out/stdout.log 2>&1 & echo $! > out/pid; }
    alive lpout/pid || { POLL_MS=${POLL_MS:-10000} setsid nohup node lp_paper.js lpout/universe.json lpout < /dev/null > lpout/stdout.log 2>&1 & echo $! > lpout/pid; }
    sleep 1; "$0" status ;;
  stop) for f in out/pid lpout/pid; do alive $f && kill "$(cat $f)"; rm -f $f; done; echo stopped ;;
  status) for f in out/pid lpout/pid; do alive $f && echo "$f: running (pid $(cat $f))" || echo "$f: stopped"; done ;;
  report) node report_lat.js out; node report_lp.js lpout ;;
  *) echo "usage: $0 start|stop|status|report" ;;
esac
