"""
Build API-safe payloads from the same session + telemetry pipeline as main.py.
"""

from __future__ import annotations

import numpy as np

from src.lib.tyres import TYRE_EXPECTED_STINT_LAPS
from src.f1_data import get_circuit_rotation, get_race_telemetry, load_session
from src.web.track_geometry import build_track_from_example_lap, extract_race_events


def _tyre_expected_laps_json() -> dict[str, int]:
    return {str(k): int(v) for k, v in TYRE_EXPECTED_STINT_LAPS.items()}


def load_example_lap_for_track(
    year: int,
    round_number: int,
    session_type: str,
    session,
    *,
    skip_quali_for_track: bool = False,
):
    """
    Prefer qualifying fastest lap for DRS-aware track geometry; else fastest lap of `session`.

    When ``skip_quali_for_track`` is True (live web API), do **not** load a second FastF1 session
    (Qualifying). That load duplicated ~half the startup cost even with cached API data. Static
    export keeps the default (quali preferred) for parity with the desktop app.
    """
    example_lap = None
    if session_type == "Q":
        fastest_lap = session.laps.pick_fastest()
        if fastest_lap is None and len(session.laps) > 0:
            fastest_lap = session.laps.iloc[0]
        if fastest_lap is not None:
            example_lap = fastest_lap.get_telemetry()
        return example_lap
    if not skip_quali_for_track:
        try:
            quali_session = load_session(year, round_number, "Q")
            if quali_session is not None and len(quali_session.laps) > 0:
                fastest_quali = quali_session.laps.pick_fastest()
                if fastest_quali is not None:
                    quali_telemetry = fastest_quali.get_telemetry()
                    if quali_telemetry is not None and "DRS" in quali_telemetry.columns:
                        example_lap = quali_telemetry
        except Exception:
            pass

    if example_lap is None:
        fastest_lap = session.laps.pick_fastest()
        if fastest_lap is not None:
            example_lap = fastest_lap.get_telemetry()

    return example_lap


def _downsample_1d(arr, max_points: int):
    arr = np.asarray(arr, dtype=float)
    n = len(arr)
    if n <= 0:
        return []
    if n <= max_points:
        return arr.tolist()
    idx = np.linspace(0, n - 1, max_points).astype(int)
    return arr[idx].tolist()


def build_track_payload(example_lap, max_points: int = 2500) -> dict:
    """Serialize track geometry for the browser (world coordinates)."""
    (
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
    ) = build_track_from_example_lap(example_lap)

    px = plot_x_ref.to_numpy() if hasattr(plot_x_ref, "to_numpy") else np.asarray(plot_x_ref)
    py = plot_y_ref.to_numpy() if hasattr(plot_y_ref, "to_numpy") else np.asarray(plot_y_ref)
    xi = x_inner.to_numpy() if hasattr(x_inner, "to_numpy") else np.asarray(x_inner)
    yi = y_inner.to_numpy() if hasattr(y_inner, "to_numpy") else np.asarray(y_inner)
    xo = x_outer.to_numpy() if hasattr(x_outer, "to_numpy") else np.asarray(x_outer)
    yo = y_outer.to_numpy() if hasattr(y_outer, "to_numpy") else np.asarray(y_outer)

    zones_out = []
    for z in drs_zones:
        zones_out.append(
            {
                "start": {
                    "x": float(z["start"]["x"]),
                    "y": float(z["start"]["y"]),
                    "index": int(z["start"]["index"]),
                },
                "end": {
                    "x": float(z["end"]["x"]),
                    "y": float(z["end"]["y"]),
                    "index": int(z["end"]["index"]),
                },
            }
        )

    # Lap telemetry index 0 is start/finish; span inner→outer across track width
    finish_line = {
        "start": {"x": float(xi[0]), "y": float(yi[0])},
        "end": {"x": float(xo[0]), "y": float(yo[0])},
    }

    return {
        "centerline": {"x": _downsample_1d(px, max_points), "y": _downsample_1d(py, max_points)},
        "inner": {"x": _downsample_1d(xi, max_points), "y": _downsample_1d(yi, max_points)},
        "outer": {"x": _downsample_1d(xo, max_points), "y": _downsample_1d(yo, max_points)},
        "bounds": {
            "x_min": float(x_min),
            "x_max": float(x_max),
            "y_min": float(y_min),
            "y_max": float(y_max),
        },
        "drs_zones": zones_out,
        "finish_line": finish_line,
    }


def driver_teams_by_code(session) -> dict[str, str]:
    """Abbreviation → team name (e.g. NOR → McLaren) for client car models."""
    out: dict[str, str] = {}
    try:
        for num in session.drivers:
            info = session.get_driver(num)
            code = str(info.get("Abbreviation", "") or "")
            if not code:
                continue
            team = info.get("TeamName")
            out[code] = str(team) if team is not None else ""
    except Exception:
        return {}
    return out


def driver_colors_to_hex(driver_colors: dict) -> dict[str, str]:
    out = {}
    for code, rgb in driver_colors.items():
        if isinstance(rgb, (list, tuple)) and len(rgb) >= 3:
            out[code] = "#{:02x}{:02x}{:02x}".format(
                int(rgb[0]), int(rgb[1]), int(rgb[2])
            )
    return out


def load_race_replay_payload(
    year: int,
    round_number: int,
    session_type: str,
    *,
    include_race_events: bool = True,
    prefer_quali_for_track_geometry: bool = False,
) -> dict:
    """
    Run the same pipeline as main.py for race/sprint/qualifying: session load, telemetry, track, meta.
    session_type: 'R', 'S', or 'Q'

    include_race_events: the web app uses race_events for scrub markers / DNF rows (default True).

    prefer_quali_for_track_geometry: when True and session is race/sprint, load Qualifying once to
    build DRS-aware track geometry from the quali fastest lap (slower). Default False for the live
    API so only one FastF1 session loads. Static export may pass True for parity with older exports.
    """
    if session_type not in ("R", "S", "Q"):
        raise ValueError("session_type must be 'R', 'S', or 'Q' for replay")

    session = load_session(year, round_number, session_type)
    race_telemetry = dict(get_race_telemetry(session, session_type=session_type))
    if not race_telemetry.get("tyre_expected_laps"):
        race_telemetry["tyre_expected_laps"] = _tyre_expected_laps_json()

    example_lap = load_example_lap_for_track(
        year,
        round_number,
        session_type,
        session,
        skip_quali_for_track=not prefer_quali_for_track_geometry,
    )
    if example_lap is None:
        raise ValueError("No valid laps for track geometry")

    circuit_rotation = float(get_circuit_rotation(session))
    track = build_track_payload(example_lap)

    event = session.event
    session_info = {
        "event_name": str(event.get("EventName", "")),
        "circuit_name": str(event.get("Location", "")),
        "country": str(event.get("Country", "")),
        "year": year,
        "round": round_number,
        "date": event.get("EventDate").strftime("%B %d, %Y")
        if event.get("EventDate") is not None
        else "",
        "total_laps": race_telemetry["total_laps"],
        "circuit_length_m": float(example_lap["Distance"].max())
        if "Distance" in example_lap.columns
        else None,
    }

    driver_colors_hex = driver_colors_to_hex(race_telemetry["driver_colors"])
    driver_teams = driver_teams_by_code(session)

    if include_race_events:
        race_events = extract_race_events(
            race_telemetry["frames"],
            race_telemetry["track_statuses"],
            race_telemetry["total_laps"] or 0,
        )
        # JSON-serialize-friendly race_events (may contain numpy types in edge cases)
        race_events_json = []
        for ev in race_events:
            race_events_json.append(
                {
                    "type": ev.get("type"),
                    "frame": int(ev["frame"]) if ev.get("frame") is not None else None,
                    "end_frame": int(ev["end_frame"]) if ev.get("end_frame") is not None else None,
                    "label": ev.get("label", ""),
                    "lap": ev.get("lap"),
                }
            )
    else:
        race_events_json = []

    return {
        "session": session,
        "frames": race_telemetry["frames"],
        "driver_colors": driver_colors_hex,
        "driver_teams": driver_teams,
        "track_statuses": race_telemetry["track_statuses"],
        "total_laps": race_telemetry["total_laps"],
        "max_tyre_life": race_telemetry.get("max_tyre_life") or {},
        "tyre_expected_laps": race_telemetry.get("tyre_expected_laps")
        or _tyre_expected_laps_json(),
        "circuit_rotation": circuit_rotation,
        "session_info": session_info,
        "track": track,
        "race_events": race_events_json,
    }
