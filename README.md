# Kobalt events

The online feed for the Kobalt Minecraft mod: news posts, limited-time challenges and the looks they win.

- **Editor:** https://kq1an.github.io/kobalt-events/editor/ - make a challenge or a news post, then **Publish**. GitHub opens with
  the update filled in; click **Commit changes** (your GitHub login, with 2FA, is the only way in).
- **The robot** (`.github/workflows/publish.yml` + `tools/publish.mjs`) checks each update with the same rules as the mod, adds it to
  `kobalt-feed.json`, signs it with the key in this repo's secret vault (`FEED_SIGNING_KEY`), and publishes it.
- **The mod** downloads `kobalt-feed.json` every few hours, checks the signature with the public key built into it, and throws away
  anything else. It's data only: text, numbers, colours and small pixel pictures, every field checked.
- **If the main key is ever leaked:** in `publish.yml` use `secrets.FEED_BACKUP_KEY` for `FEED_KEY` and add `FEED_SIGNER: backup`; the mod
  already trusts the backup key, and a mod update can then drop the old one.
