"""Bounded raw capture readers. No archive members are extracted to disk."""

import base64
from dataclasses import dataclass
from datetime import datetime, timezone
import gzip
import hashlib
import json
import lzma
from pathlib import Path
import re
import tarfile

MAX_PACKET = 262_144
MAX_HISTORICAL_PACKET = 1024**2
MAX_COMPRESSED = 128 * 1024**2
MAX_EXPANDED = 8 * 1024**3
FEEDS = {'numbered', 'ace', 'bdfm', 'g', 'jz', 'l', 'nqrw', 'si'}
HISTORICAL_FEEDS = {
    '1234567': 'numbered',
    'ACE': 'ace',
    'BDFM': 'bdfm',
    'G': 'g',
    'JZ': 'jz',
    'L': 'l',
    'NQRW': 'nqrw',
    'SIR': 'si',
}
MEMBER = re.compile(
    r'nycsubway_(1234567|ACE|BDFM|G|JZ|L|NQRW|SIR|alerts)_(\d{8}T\d{6}\.\d+Z)_[a-z0-9]+\.gtfsrt'
)


@dataclass
class Capture:
    capture_id: str
    feed_id: str
    captured_at: datetime
    received_at: datetime | None
    outcome: str
    payload: bytes | None
    source_kind: str


def timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError('Invalid capture timestamp')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Capture timestamp requires a timezone')
    return parsed.astimezone(timezone.utc)


def fingerprint(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


def live_captures(path):
    if (
        path.is_symlink()
        or not path.name.endswith('.ndjson.gz')
        or path.stat().st_size > 8 * 1024**2
    ):
        raise ValueError('Expected a sealed bounded archive part')
    expanded = 0
    with gzip.open(path, 'rb') as source:
        while line := source.readline(400_001):
            expanded += len(line)
            if len(line) > 400_000 or not line.endswith(b'\n') or expanded > 8 * 1024**2:
                raise ValueError('Archive part exceeds bounds or contains a partial record')
            row = json.loads(line)
            expected = {
                'version',
                'capture_id',
                'feed_id',
                'received_at',
                'outcome',
                'payload_sha256',
                'payload_base64',
            }
            if not isinstance(row, dict) or set(row) != expected:
                raise ValueError('Invalid capture envelope')
            if (
                type(row['version']) is not int
                or row['version'] != 1
                or not isinstance(row['feed_id'], str)
                or row['feed_id'] not in FEEDS
            ):
                raise ValueError('Invalid capture envelope')
            if not isinstance(row['capture_id'], str) or not re.fullmatch(
                r'[a-f0-9-]{36}', row['capture_id']
            ):
                raise ValueError('Invalid capture identity')
            if not isinstance(row['outcome'], str) or row['outcome'] not in {
                'changed',
                'unchanged',
                'rejected',
                'fetch_error',
            }:
                raise ValueError('Invalid capture outcome')
            payload = None
            if row['outcome'] != 'fetch_error':
                if not isinstance(row['payload_base64'], str):
                    raise ValueError('Missing raw packet')
                payload = base64.b64decode(row['payload_base64'], validate=True)
                if (
                    len(payload) > MAX_PACKET
                    or hashlib.sha256(payload).hexdigest() != row['payload_sha256']
                ):
                    raise ValueError('Raw packet checksum mismatch')
            elif row['payload_base64'] is not None or row['payload_sha256'] is not None:
                raise ValueError('Fetch error cannot include a payload')
            received = timestamp(row['received_at'])
            yield Capture(
                row['capture_id'],
                row['feed_id'],
                received,
                received if payload is not None else None,
                row['outcome'],
                payload,
                'geoatlas',
            )


class XZReader:
    """Limit both the XZ dictionary and total decompressed bytes."""

    def __init__(self, source):
        self.source = source
        self.decoder = lzma.LZMADecompressor(memlimit=128 * 1024**2)
        self.expanded = 0

    def read(self, size):
        result = bytearray()
        while len(result) < size and not self.decoder.eof:
            chunk = self.source.read(65536) if self.decoder.needs_input else b''
            if not chunk and self.decoder.needs_input:
                raise ValueError('Truncated XZ archive')
            decoded = self.decoder.decompress(chunk, max_length=min(size - len(result), 65536))
            self.expanded += len(decoded)
            if self.expanded > MAX_EXPANDED:
                raise ValueError('Decompressed archive exceeds 8 GiB')
            result.extend(decoded)
        return bytes(result)


def historical_captures(path, feed=None, hour=None, stats=None):
    if path.is_symlink() or path.stat().st_size > MAX_COMPRESSED:
        raise ValueError('Historical archive exceeds compressed size limit')
    with path.open('rb') as source:
        stream = XZReader(source)
        count = 0
        if stats is not None:
            stats.update(archive_expanded_bytes=0, archive_members=0)
        while header := stream.read(512):
            if header == bytes(512):
                # Read the remainder to verify the XZ footer and integrity checksum.
                while tail := stream.read(65536):
                    if tail.strip(b'\0'):
                        raise ValueError('Unexpected data after TAR end')
                if stream.decoder.unused_data or source.read(1):
                    raise ValueError('Unexpected bytes after the XZ stream')
                if stats is not None:
                    stats.update(archive_expanded_bytes=stream.expanded, archive_members=count)
                return
            if len(header) != 512:
                raise ValueError('Truncated TAR header')
            member = tarfile.TarInfo.frombuf(header, 'utf-8', 'strict')
            count += 1
            if (
                count > 200_000
                or not member.isfile()
                or member.size < 0
                or member.size > MAX_HISTORICAL_PACKET
            ):
                raise ValueError(
                    f'Unsupported archive member: type={member.type!r}, bytes={member.size}, count={count}'
                )
            content = stream.read(member.size)
            padding = stream.read((-member.size) % 512)
            if len(content) != member.size or len(padding) != (-member.size) % 512:
                raise ValueError('Truncated TAR member')
            if member.name == 'gtfsrt_readme.md':
                continue
            match = MEMBER.fullmatch(member.name)
            if not match:
                raise ValueError(f'Unknown historical member format: {member.name[:160]!r}')
            if match[1] == 'alerts':
                continue
            feed_id = HISTORICAL_FEEDS[match[1]]
            captured = datetime.strptime(match[2], '%Y%m%dT%H%M%S.%fZ').replace(tzinfo=timezone.utc)
            if (feed and feed_id != feed) or (hour is not None and captured.hour != hour):
                continue
            identity = hashlib.sha256(member.name.encode() + content).hexdigest()
            yield Capture(identity, feed_id, captured, None, 'archived', content, 'subwaydata.nyc')
        raise ValueError('Missing TAR end marker')
