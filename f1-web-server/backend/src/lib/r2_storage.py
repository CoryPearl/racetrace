"""Cloudflare R2 (S3-compatible): ``data/...`` JSON and ``compressed_computed_data/*.pkl.xz`` pickles."""

from __future__ import annotations

import os
from functools import lru_cache

from botocore.exceptions import ClientError


def r2_use_remote() -> bool:
    """
    When False, the server never reads from R2 (only local ``frontend/data``,
    ``compressed_computed_data/``, FastF1 cache, etc.).

    - ``DATA_SOURCE=local`` — disk only; R2 credentials in ``.env`` are ignored.
    - ``USE_LOCAL_DATA=1`` / ``true`` / ``yes`` — same as ``DATA_SOURCE=local``.
    - Otherwise (default or ``DATA_SOURCE=r2``): use R2 when credentials are set.
    """
    if os.environ.get("DATA_SOURCE", "").strip().lower() == "local":
        return False
    if os.environ.get("USE_LOCAL_DATA", "").strip().lower() in ("1", "true", "yes"):
        return False
    return True


def r2_credentials_configured() -> bool:
    """True when R2 remote is enabled and all R2 env vars are set."""
    if not r2_use_remote():
        return False
    return bool(
        os.environ.get("R2_ACCOUNT_ID", "").strip()
        and os.environ.get("R2_ACCESS_KEY_ID", "").strip()
        and os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
        and os.environ.get("R2_BUCKET_NAME", "").strip()
    )


@lru_cache
def _r2_client_and_bucket():
    account = os.environ.get("R2_ACCOUNT_ID", "").strip()
    key_id = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
    secret = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
    bucket = os.environ.get("R2_BUCKET_NAME", "").strip()
    if not (account and key_id and secret and bucket):
        return None
    import boto3

    client = boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=key_id,
        aws_secret_access_key=secret,
        region_name="auto",
    )
    return client, bucket


def r2_key_prefix() -> str:
    """Optional prefix inside the bucket (no leading/trailing slashes)."""
    return os.environ.get("R2_KEY_PREFIX", "").strip().strip("/")


def r2_object_key_for_compressed_computed_xz(rel_pkl: str) -> str:
    """
    Key for ``compressed_computed_data/<name>.pkl.xz`` (same layout as local repo).

    ``rel_pkl`` is the filename only, e.g.
    ``2018_Season_Round_10:_British_Grand_Prix_-_Race_race_telemetry.pkl``
    """
    rel = rel_pkl.replace("\\", "/").strip("/")
    prefix = r2_key_prefix()
    core = f"compressed_computed_data/{rel}.xz"
    if prefix:
        return f"{prefix}/{core}"
    return core


def try_read_compressed_computed_xz_from_r2(rel_pkl: str) -> bytes | None:
    """
    Fetch ``.pkl.xz`` bytes from R2 if configured; ``None`` if missing or R2 off.

    Same object layout as local ``compressed_computed_data/<rel>.xz``.
    """
    if not r2_use_remote():
        return None
    rel = rel_pkl.replace("\\", "/").strip("/")
    if not rel or any(part == ".." for part in rel.split("/")):
        return None
    cfg = _r2_client_and_bucket()
    if cfg is None:
        return None
    client, bucket = cfg
    key = r2_object_key_for_compressed_computed_xz(rel)
    try:
        obj = client.get_object(Bucket=bucket, Key=key)
    except Exception:
        return None
    body = obj.get("Body")
    if body is None:
        return None
    return body.read()


def r2_object_key_for_data_path(relative_path: str) -> str:
    """
    Map a path under ``frontend/data`` to the R2 object key.

    ``relative_path`` uses forward slashes, e.g. ``schedule/2026.json`` or
    ``replays/2026_r01_R/meta.json``.
    """
    rel = relative_path.replace("\\", "/").strip("/")
    prefix = r2_key_prefix()
    core = f"data/{rel}"
    if prefix:
        return f"{prefix}/{core}"
    return core


def r2_connection_status() -> dict:
    """
    Safe diagnostics for GET /api/health/r2 (no secrets).
    Lists keys under data/ and compressed_computed_data/, and probes optional JSON vs pickle paths.
    """
    account = os.environ.get("R2_ACCOUNT_ID", "").strip()
    bucket = os.environ.get("R2_BUCKET_NAME", "").strip()
    prefix = r2_key_prefix()
    out: dict = {
        "credentials_configured": r2_credentials_configured(),
        "endpoint_host": f"{account}.r2.cloudflarestorage.com" if account else None,
        "bucket": bucket or None,
        "key_prefix": prefix if prefix else None,
        "list_objects_ok": None,
        "keys_under_data_prefix": None,
        "keys_under_compressed_computed_prefix": None,
        "keys_in_bucket_sample": None,
        "example_json_meta_key_optional": None,
        "example_race_pickle_key": None,
        "example_race_pickle_head_ok": None,
        "error": None,
    }
    if not r2_use_remote():
        out["data_source"] = "local"
        out["r2_remote_enabled"] = False
        out["credentials_configured"] = False
        out["summary"] = (
            "DATA_SOURCE=local (or USE_LOCAL_DATA=1) — R2 reads disabled. "
            "Use frontend/data/ and compressed_computed_data/ on disk."
        )
        return out
    out["data_source"] = os.environ.get("DATA_SOURCE", "r2").strip() or "r2"
    out["r2_remote_enabled"] = True
    example_rel = "replays/2025_r01_R/meta.json"
    example_json_key = r2_object_key_for_data_path(example_rel)
    out["example_json_meta_key_optional"] = example_json_key
    if not r2_credentials_configured():
        out["error"] = "Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME"
        return out
    cfg = _r2_client_and_bucket()
    if cfg is None:
        out["error"] = "Could not build S3 client"
        return out
    client, bkt = cfg
    try:
        r1 = client.list_objects_v2(Bucket=bkt, MaxKeys=20, Prefix="data/")
        keys_data = [c["Key"] for c in (r1.get("Contents") or []) if c.get("Key")]
        out["keys_under_data_prefix"] = keys_data
        r_cc = client.list_objects_v2(
            Bucket=bkt, MaxKeys=20, Prefix="compressed_computed_data/"
        )
        keys_cc = [c["Key"] for c in (r_cc.get("Contents") or []) if c.get("Key")]
        out["keys_under_compressed_computed_prefix"] = keys_cc
        out["list_objects_ok"] = True
        if not keys_data:
            r2 = client.list_objects_v2(Bucket=bkt, MaxKeys=15)
            keys2 = [c["Key"] for c in (r2.get("Contents") or []) if c.get("Key")]
            out["keys_in_bucket_sample"] = keys2
            if keys_cc:
                out["note"] = (
                    "No data/ objects — OK if you only use precomputed pickles. "
                    "Session load reads compressed_computed_data/*.pkl.xz (set R2_COMPUTED_FIRST=1 "
                    "when the server has no local compressed_computed_data/). "
                    "data/replays/ JSON is optional (static bundles)."
                )
            else:
                out["note"] = (
                    "No data/ prefix in sample. Add compressed_computed_data/*.pkl.xz and/or "
                    "data/replays/<slug>/ for JSON bundles."
                )
        race_pkl_key = None
        for k in keys_cc:
            if k.endswith(".DS_Store"):
                continue
            if "Race_race_telemetry.pkl.xz" in k:
                race_pkl_key = k
                break
        if race_pkl_key:
            out["example_race_pickle_key"] = race_pkl_key
            try:
                client.head_object(Bucket=bkt, Key=race_pkl_key)
                out["example_race_pickle_head_ok"] = True
            except Exception as e:
                out["example_race_pickle_head_ok"] = False
                out["example_race_pickle_error"] = f"{type(e).__name__}: {e}"
    except Exception as e:
        out["list_objects_ok"] = False
        out["error"] = f"{type(e).__name__}: {e}"
        return out

    try:
        client.head_object(Bucket=bkt, Key=example_json_key)
        out["example_json_meta_exists"] = True
    except ClientError as e:
        err = e.response.get("Error", {}) if e.response else {}
        code = str(err.get("Code", ""))
        if code in ("404", "NoSuchKey", "NotFound") or "404" in str(e):
            out["example_json_meta_exists"] = False
            out["example_json_meta_note"] = (
                "Optional path — 404 is normal if you only use compressed_computed_data pickles."
            )
        else:
            out["example_json_meta_exists"] = False
            out["example_json_meta_head_error"] = f"{type(e).__name__}: {e}"
    except Exception as e:
        out["example_json_meta_exists"] = False
        out["example_json_meta_head_error"] = f"{type(e).__name__}: {e}"

    if out.get("error"):
        out["summary"] = "R2 misconfigured or unreachable — see error"
    elif out.get("example_race_pickle_head_ok"):
        out["summary"] = (
            "R2 OK — compressed race telemetry pickle is reachable (typical session-load path)"
        )
    elif out.get("keys_under_compressed_computed_prefix"):
        out["summary"] = "R2 OK — compressed_computed_data/ has objects (check example_race_pickle_head_ok)"
    elif out.get("keys_under_data_prefix"):
        out["summary"] = "R2 OK — data/ has objects (JSON bundle path)"
    else:
        out["summary"] = "R2 connected — upload compressed_computed_data/ and/or data/ content"
    return out


def try_read_bytes_from_r2(relative_under_data: str) -> bytes | None:
    """
    Fetch object bytes if R2 is configured; return None if missing or not configured.

    ``relative_under_data`` is relative to ``data/``, e.g. ``schedule/2026.json``.
    """
    if not r2_use_remote():
        return None
    cfg = _r2_client_and_bucket()
    if cfg is None:
        return None
    client, bucket = cfg
    key = r2_object_key_for_data_path(relative_under_data)
    try:
        obj = client.get_object(Bucket=bucket, Key=key)
    except Exception:
        return None
    body = obj.get("Body")
    if body is None:
        return None
    return body.read()
