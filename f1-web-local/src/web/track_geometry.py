"""
Track outline + race events for the web API — same logic as ui_components.py
without Arcade (used only by src.web.payload).
"""

from __future__ import annotations

from typing import List

import numpy as np

# Match RaceProgressBarComponent event ids (ui_components.py)
EVENT_DNF = "dnf"
EVENT_YELLOW_FLAG = "yellow_flag"
EVENT_RED_FLAG = "red_flag"
EVENT_SAFETY_CAR = "safety_car"
EVENT_VSC = "vsc"


def extract_race_events(
    frames: List[dict], track_statuses: List[dict], total_laps: int
) -> List[dict]:
    events: List[dict] = []

    if not frames:
        return events

    n_frames = len(frames)
    prev_drivers: set = set()
    sample_rate = 25

    for i in range(0, n_frames, sample_rate):
        frame = frames[i]
        drivers_data = frame.get("drivers", {})
        current_drivers = set(drivers_data.keys())

        if prev_drivers:
            dnf_drivers = prev_drivers - current_drivers
            for driver_code in dnf_drivers:
                prev_frame = frames[max(0, i - sample_rate)]
                driver_info = prev_frame.get("drivers", {}).get(driver_code, {})
                lap = driver_info.get("lap", "?")

                events.append(
                    {
                        "type": EVENT_DNF,
                        "frame": i,
                        "label": driver_code,
                        "lap": lap,
                    }
                )

        prev_drivers = current_drivers

    for status in track_statuses:
        status_code = str(status.get("status", ""))
        start_time = status.get("start_time", 0)
        end_time = status.get("end_time")

        fps = 25
        start_frame = int(start_time * fps)
        end_frame = int(end_time * fps) if end_time else start_frame + 250

        if end_frame <= 0:
            continue

        if n_frames > 0:
            end_frame = min(end_frame, n_frames)

        event_type = None
        if status_code == "2":
            event_type = EVENT_YELLOW_FLAG
        elif status_code == "4":
            event_type = EVENT_SAFETY_CAR
        elif status_code == "5":
            event_type = EVENT_RED_FLAG
        elif status_code in ("6", "7"):
            event_type = EVENT_VSC

        if event_type:
            events.append(
                {
                    "type": event_type,
                    "frame": start_frame,
                    "end_frame": end_frame,
                    "label": "",
                    "lap": None,
                }
            )

    return events


def plotDRSzones(example_lap):
    x_val = example_lap["X"]
    y_val = example_lap["Y"]
    drs_zones = []
    drs_start = None

    for i, val in enumerate(example_lap["DRS"]):
        if val in [10, 12, 14]:
            if drs_start is None:
                drs_start = i
        else:
            if drs_start is not None:
                drs_end = i - 1
                zone = {
                    "start": {
                        "x": x_val.iloc[drs_start],
                        "y": y_val.iloc[drs_start],
                        "index": drs_start,
                    },
                    "end": {
                        "x": x_val.iloc[drs_end],
                        "y": y_val.iloc[drs_end],
                        "index": drs_end,
                    },
                }
                drs_zones.append(zone)
                drs_start = None

    if drs_start is not None:
        drs_end = len(example_lap["DRS"]) - 1
        zone = {
            "start": {
                "x": x_val.iloc[drs_start],
                "y": y_val.iloc[drs_start],
                "index": drs_start,
            },
            "end": {
                "x": x_val.iloc[drs_end],
                "y": y_val.iloc[drs_end],
                "index": drs_end,
            },
        }
        drs_zones.append(zone)

    return drs_zones


def build_track_from_example_lap(example_lap, track_width=200):
    drs_zones = plotDRSzones(example_lap)
    plot_x_ref = example_lap["X"]
    plot_y_ref = example_lap["Y"]

    dx = np.gradient(plot_x_ref)
    dy = np.gradient(plot_y_ref)

    norm = np.sqrt(dx**2 + dy**2)
    norm[norm == 0] = 1.0
    dx /= norm
    dy /= norm

    nx = -dy
    ny = dx

    x_outer = plot_x_ref + nx * (track_width / 2)
    y_outer = plot_y_ref + ny * (track_width / 2)
    x_inner = plot_x_ref - nx * (track_width / 2)
    y_inner = plot_y_ref - ny * (track_width / 2)

    x_min = min(plot_x_ref.min(), x_inner.min(), x_outer.min())
    x_max = max(plot_x_ref.max(), x_inner.max(), x_outer.max())
    y_min = min(plot_y_ref.min(), y_inner.min(), y_outer.min())
    y_max = max(plot_y_ref.max(), y_inner.max(), y_outer.max())

    return (
        plot_x_ref,
        plot_y_ref,
        x_inner,
        y_inner,
        x_outer,
        y_outer,
        x_min,
        x_max,
        y_min,
        y_max,
        drs_zones,
    )
