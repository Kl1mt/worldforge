# Your legal pages

Put your filled-in `impressum.md` and `datenschutz.md` in this directory on the server. They are mounted read-only into the server container and replace the placeholder templates from `content/legal/` (copy those as a starting point). Edits show on the next page load, without a restart. The files are git-ignored, so your address never lands in the repository.

See `docs/DEPLOY.md`, "Legal pages".
