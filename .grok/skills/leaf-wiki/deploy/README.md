# Leaf beliefs maintain + calibrate — deploy on oc

Canonical units + scripts live in **hzr-skills** `skills/leaf-wiki/`.

P1: `maintain-beliefs.py` (lint / stale).  
P2: `calibrate-beliefs.py` → per-leaf `.wiki/_meta/calibration.md` + `state/last-report.*`.  
Wrapper: `beliefs-daily.sh` runs both.

## Install (PA / hub agent)

On **oc** (as steve, with sudo for units):

```bash
mkdir -p ~/.local/share/hzr-skills/leaf-wiki
# from hzr-skills checkout:
rsync -a skills/leaf-wiki/scripts skills/leaf-wiki/deploy \
  ~/.local/share/hzr-skills/leaf-wiki/
chmod +x ~/.local/share/hzr-skills/leaf-wiki/scripts/*.sh \
         ~/.local/share/hzr-skills/leaf-wiki/scripts/*.py

# Registry copy for empty-leaf G1 (from hub leaf-projects.yaml)
# scp /root/tench/hub/_meta/leaf-projects.yaml \
#   steve@oc:~/.local/share/hzr-skills/leaf-wiki/leaf-projects.yaml

sudo install -m 644 ~/.local/share/hzr-skills/leaf-wiki/deploy/leaf-beliefs-maintain.service /etc/systemd/system/
sudo install -m 644 ~/.local/share/hzr-skills/leaf-wiki/deploy/leaf-beliefs-maintain.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now leaf-beliefs-maintain.timer
sudo systemctl start leaf-beliefs-maintain.service
```

Leaves need `.wiki/beliefs/` (scaffold at register-leaf / init).

## Human report (Tench)

Oc has no 1Password/`op`; HA Companion notify stays on **Tench**.

```bash
# After oc daily run (~07:15 UTC), Tench ~07:20:
/root/tench/scripts/leaf-beliefs-report.sh
```

Unit files: `tench-leaf-beliefs-report.service` + `.timer` under `/root/tench/ops/leaf-beliefs-report/`.
Fetches `state/last-report.txt` via `oc_ssh`, sends counts via `notify-hub-event.sh` → HA Companion.
Missing report or calibrate hard-fail (G3) → non-zero (G5).
