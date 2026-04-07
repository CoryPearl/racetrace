# F1 Race Replay (web)

This project is a **browser-based** Formula 1 session replay and telemetry viewer. You load a race weekend session and watch cars move on the track with timing, tyres, and playback controls—similar in spirit to a live broadcast replay, but driven by [FastF1](https://theoehrly.github.io/Fast-F1/) data and optional precomputed telemetry. The stack here is a **FastAPI** backend and a **static JavaScript** front end (no desktop game engine).

The repo contains two related layouts: a single-folder **local** bundle ([`f1-web-local/`](f1-web-local/)) and a split **server** bundle ([`f1-web-server/`](f1-web-server/)) with optional object storage for schedules, replay JSON, and compressed pickles. Both share the same core ideas (schedules under `data/schedule/`, optional static replay bundles, helper scripts for prefetch and export).

---

## Credit

This work is inspired by and builds on **[f1-race-replay](https://github.com/IAmTomShaw/f1-race-replay)** by [Tom Shaw](https://github.com/IAmTomShaw) — an interactive Formula 1 race visualisation and data analysis tool built in Python with an Arcade-based viewer. That project is MIT-licensed and documents telemetry, Safety Car behaviour, qualifying support, and more on [its README](https://github.com/IAmTomShaw/f1-race-replay). This repository is a **separate web implementation**; attribution and thanks to the original authors and contributors there.

---

## Data

Telemetry and championship content are subject to Formula 1 and FastF1 terms of use. This code is a viewer layer on top of those sources.
