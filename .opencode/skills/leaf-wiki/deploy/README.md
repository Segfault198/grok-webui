# Leaf beliefs maintain — deploy on oc

Canonical units + script live in **hzr-skills** `skills/leaf-wiki/`.

## Install (PA / hub agent)

```bash
mkdir -p ~/.local/share/hzr-skills/leaf-wiki
rsync -a skills/leaf-wiki/scripts skills/leaf-wiki/deploy \
  ~/.local/share/hzr-skills/leaf-wiki/

sudo install -m 644 ~/.local/share/hzr-skills/leaf-wiki/deploy/leaf-beliefs-maintain.service /etc/systemd/system/
sudo install -m 644 ~/.local/share/hzr-skills/leaf-wiki/deploy/leaf-beliefs-maintain.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now leaf-beliefs-maintain.timer
sudo systemctl start leaf-beliefs-maintain.service
```

Leaves need `.wiki/beliefs/` (scaffold at register-leaf / init).
