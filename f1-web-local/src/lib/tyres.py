import pandas as pd


tyre_compounds_ints = {
  "SOFT": 0,
  "MEDIUM": 1,
  "HARD": 2,
  "INTERMEDIATE": 3,
  "WET": 4,
}

# Typical useful stint length per compound for UI “laps left” (not official F1 data).
# “Laps left” uses tyre_laps_since_pit from telemetry (0 = first lap after pit, +1 each lap).
TYRE_EXPECTED_STINT_LAPS = {
    0: 22,  # SOFT
    1: 35,  # MEDIUM
    2: 55,  # HARD
    3: 28,  # INTERMEDIATE
    4: 38,  # WET
}

def get_tyre_compound_int(compound_str):
  if pd.isna(compound_str):
    return -1
  s = str(compound_str).strip()
  if not s:
    return -1
  return int(tyre_compounds_ints.get(s.upper(), -1))

def get_tyre_compound_str(compound_int):
  for k, v in tyre_compounds_ints.items():
    if v == compound_int:
      return k
  return "UNKNOWN"