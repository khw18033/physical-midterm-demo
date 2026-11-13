"""seq_plan · mission_seq 시험 (FC 없이).

    cd ~/drone && ./venv/bin/python -m pytest scripts/test_seq_plan.py -q

⚠ scripts/ 폴더 전체를 pytest 에 넘기지 말 것 — test_sar.py · test_sar_rtk.py 는 시험이 아니라 비행 스크립트다.
"""

from __future__ import annotations

import asyncio
import math
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import seq_plan as sp  # noqa: E402

LAT0, LON0 = 36.35, 127.30


def steps(*texts):
    return [sp.parse_step(t) for t in texts]


def build(texts, h0=0.0, **cfg):
    return sp.build(steps(*texts), sp.Config(**cfg), LAT0, LON0, h0)


def close(a, b, tol=1e-6):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


# ── 단계 해석 ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text, kind, value, speed, cap", [
    ("right:3", "right", 3, None, False),
    ("우 3", "right", 3, None, False),
    ("오른쪽3", "right", 3, None, False),
    ("앞 1.5", "forward", 1.5, None, False),
    ("forward:2@0.5+cap", "forward", 2, 0.5, True),
    ("앞 2 @0.5 +캡처", "forward", 2, 0.5, True),
    ("시계 90", "cw", 90, None, False),
    ("반시계:45", "ccw", 45, None, False),
    ("대기 5", "hover", 5, None, False),
    ("HOVER:5", "hover", 5, None, False),
])
def test_parse_step(text, kind, value, speed, cap):
    assert sp.parse_step(text) == sp.Step(kind, value, speed, cap)


@pytest.mark.parametrize("text", ["", "up:3", "right", "right:-3", "right:3@", "right:abc", "3:right"])
def test_parse_step_rejects(text):
    with pytest.raises(ValueError):
        sp.parse_step(text)


def test_text_roundtrip_is_canonical():
    for t in ("right:3", "forward:2@0.5+cap", "cw:90", "hover:5", "left:1.25"):
        s = sp.parse_step(t)
        assert s.text() == t and sp.parse_step(s.text()) == s
    assert sp.parse_step("우 3.000").text() == "right:3"


@pytest.mark.parametrize("x, s", [(3, "3"), (3.0, "3"), (0.5, "0.5"), (1.25, "1.25"), (1.23456, "1.235"), (-0.0001, "0")])
def test_fmt(x, s):
    assert sp.fmt(x) == s


@pytest.mark.parametrize("texts, cfg, msg", [
    (["right:0.5"], {}, "1~50m"),
    (["right:51"], {}, "1~50m"),
    (["cw:361"], {}, "1~360"),
    (["hover:0.5"], {}, "1~60"),
    (["cw:90@1"], {}, "이동 단계에만"),
    (["right:3@9"], {}, "0.5~5"),
    (["right:1"], {"accept_radius": 1.0}, "도달 반경"),
    (["forward:30", "right:30"], {}, "--max-radius"),
    (["forward:50", "back:50", "forward:50", "back:50", "forward:50", "back:50", "forward:50"],
     {"max_radius": 60}, "총 이동 거리"),
    (["right:3"], {"altitude": 31}, "고도"),
    (["right:3"], {"gap": 5}, "--gap"),
    (["right:3"], {"land": "there"}, "착륙"),
    (["right:3"] * 21, {"max_radius": 100}, "단계 수"),
])
def test_build_rejects(texts, cfg, msg):
    with pytest.raises(ValueError, match=msg):
        build(texts, **cfg)


# ── 좌표: 방향은 그 단계 시점의 기수 기준(회전 누적) ─────────────────────────

@pytest.mark.parametrize("h0, texts, end_ne, yaw", [
    (0, ["right:3"], (0, 3), 0),                            # 북쪽 보고 오른쪽 = 동
    (90, ["right:3"], (-3, 0), 90),                         # 동쪽 보고 오른쪽 = 남
    (0, ["back:2"], (-2, 0), 0),
    (0, ["cw:90", "forward:2"], (0, 2), 90),                # 돌고 나서 앞 = 동
    (0, ["ccw:90", "forward:2"], (0, -2), 270),
    (0, ["cw:90", "right:2"], (-2, 0), 90),                 # 동쪽 보고 오른쪽 = 남
    (30, ["cw:360", "forward:1"], (math.cos(math.radians(30)), math.sin(math.radians(30))), 30),
    (0, ["right:3", "forward:1"], (1, 3), 0),              # 요청 예시: 오른쪽 3 → 앞 1
])
def test_geometry_body_frame_cumulative(h0, texts, end_ne, yaw):
    g = sp.geometry(steps(*texts), h0)
    assert close(g[-1].end, end_ne)
    assert abs(g[-1].yaw_end - yaw) < 1e-9


def test_turned_counts_beyond_360():
    g = sp.geometry(steps("cw:270", "cw:180", "ccw:90"), 0)
    assert [x.turned for x in g] == [270, 450, 360]


@pytest.mark.parametrize("angle, pieces", [(90, [90]), (100, [50, 50]), (270, [90, 90, 90]), (360, [90] * 4), (45, [45])])
def test_rot_pieces(angle, pieces):
    assert sp.rot_pieces(angle) == pytest.approx(pieces)
    assert all(p <= sp.ROTATE_STEP for p in sp.rot_pieces(angle))


def test_latlon_ne_inverse():
    for n, e in ((0, 0), (10, -20), (-30, 5)):
        lat, lon = sp.latlon(LAT0, LON0, n, e)
        assert close(sp.ne(LAT0, LON0, lat, lon), (n, e), 0.01)


def test_body_frame():
    assert close(sp.body(0, 3, 0), (0, 3))
    assert close(sp.body(-3, 0, 90), (0, 3))       # 동쪽 기수에서 남쪽 3m = 오른쪽 3m


# ── 미션 항목 ────────────────────────────────────────────────────────────

def test_user_example_items():
    """5m 이륙 → 오른쪽 3m → 앞 1m → 착륙."""
    p = build(["right:3", "forward:1"], h0=0, altitude=5)
    assert [it.command for it in p.items] == [sp.NAV_TAKEOFF, sp.NAV_WAYPOINT, sp.DO_CHANGE_SPEED, sp.NAV_WAYPOINT,
                                              sp.DO_CHANGE_SPEED, sp.NAV_WAYPOINT, sp.NAV_LAND]
    assert p.roles == [("takeoff", 0), ("align", 0), ("speed", 1), ("move", 1), ("speed", 2), ("move", 2), ("land", 0)]
    assert [it.seq for it in p.items] == list(range(7)) and p.items[0].current == 1
    assert all(it.param4 == 0 for it in p.items if it.command in (sp.NAV_WAYPOINT, sp.NAV_LAND))   # 기수 고정
    land, last = p.items[-1], p.items[5]
    assert (land.x, land.y) == (last.x, last.y) and land.z == 0          # 마지막 지점에 착륙
    assert all(it.z == 5 for it in p.items[:-1] if it.command != sp.DO_CHANGE_SPEED)
    n, e = sp.ne(LAT0, LON0, last.x / 1e7, last.y / 1e7)
    assert close((n, e), (1, 3), 0.02)
    assert [(g.first_seq, g.last_seq) for g in p.geo] == [(2, 3), (4, 5)]
    assert p.step_of(3) == 1 and p.step_of(4) == 2 and p.step_of(1) == 0 and p.step_of(6) == 0 and p.step_of(99) == 0


def test_land_home_returns_to_L():
    p = build(["right:3", "forward:1"], land="home")
    assert p.roles[-3:] == [("speed", 0), ("return", 0), ("land", 0)]
    assert (p.items[-1].x, p.items[-1].y) == (p.items[0].x, p.items[0].y) == (int(round(LAT0 * 1e7)), int(round(LON0 * 1e7)))
    assert p.land_ne == (0.0, 0.0)


def test_rotation_items_and_direction():
    p = build(["ccw:270"], h0=10)
    rot = [it for it, r in zip(p.items, p.roles) if r[0] == "rot"]
    assert [it.param4 for it in rot] == pytest.approx([280, 190, 100])        # 반시계로 90° 씩
    assert [it.param1 for it in rot] == [0, 0, p.cfg.settle]                   # 마지막 조각에만 정지
    p = build(["cw:360"], h0=0)
    assert [it.param4 for it in p.items if p.roles[it.seq][0] == "rot"] == pytest.approx([90, 180, 270, 0])


def test_hover_and_speed_override():
    p = build(["forward:2@0.5", "hover:7", "right:2"], speed=2)
    speeds = [it.param2 for it in p.items if it.command == sp.DO_CHANGE_SPEED]
    assert speeds == [0.5, 2]
    hover = [it for it in p.items if p.roles[it.seq][0] == "hover"]
    assert len(hover) == 1 and hover[0].param1 == 7


def test_rest_only_between_capture_steps():
    p = build(["forward:2+cap", "right:2", "back:2+cap", "left:2+cap"])
    assert [r for r in p.roles if r[0] == "rest"] == [("rest", 1), ("rest", 3)]     # 마지막 캡처 뒤에는 없다
    rest = [it for it in p.items if p.roles[it.seq][0] == "rest"]
    assert all(it.param1 == max(p.cfg.settle, p.cfg.gap) for it in rest)
    assert build(["forward:2+cap", "right:2"]).roles.count(("rest", 1)) == 0


def test_estimate_and_limits_reported():
    p = build(["forward:4", "cw:90", "hover:5"], altitude=5, speed=1)
    # 이륙 5 + 6 + 정렬 3 + 착륙 5/0.7 + 10 / 이동 4+4+2 / 회전 3+1+2 / 대기 5
    assert p.estimate_s() == pytest.approx(5 + 6 + 3 + 5 / 0.7 + 10 + 10 + 6 + 5)
    assert p.timeout_s() == pytest.approx(p.estimate_s() * 2 + 60)
    assert p.max_r == pytest.approx(4) and p.path_m == pytest.approx(4)


def test_key_and_hash():
    a = build(["right:3", "forward:1"])
    b = sp.build(steps("우 3", "앞 1"), sp.Config(), 10.0, 20.0, 123.0)        # 현장 위치 · 기수는 키에 안 들어간다
    assert a.key() == b.key() == "v1|alt=5|spd=1|land=here|right:3;forward:1"
    assert a.hash() == b.hash() == sp.mission_hash(a.key()) and len(a.hash()) == 16
    assert build(["right:3", "forward:1"], land="home").hash() != a.hash()
    assert build(["right:3", "forward:1+cap"]).hash() != a.hash()


def test_to_json_matches_items():
    p = build(["right:3", "cw:90", "forward:2+cap"], h0=45, land="home")
    j = p.to_json()
    assert j["key"] == p.key() and j["n_items"] == len(p.items) == len(j["roles"])
    for s in j["steps"]:
        first, last = s["seq"]
        assert all(j["roles"][q][1] == s["k"] for q in range(first, last + 1))
        it = p.items[last]
        assert (round(it.x / 1e7, 7), round(it.y / 1e7, 7)) == (round(s["to"]["lat"], 7), round(s["to"]["lon"], 7))
    assert close((j["steps"][0]["to"]["fwd"], j["steps"][0]["to"]["right"]), (0, 3), 1e-3)
    assert close((j["steps"][2]["to"]["fwd"], j["steps"][2]["to"]["right"]), (0, 5), 1e-3)   # 돌고 앞 = 처음 오른쪽
    assert j["land_pt"]["n"] == 0 and j["land"] == "home"


def test_describe_every_item_and_map():
    p = build(["right:3", "forward:1", "cw:90", "forward:2@0.5+cap", "hover:5", "ccw:270+cap", "left:2"], land="home")
    for seq in range(len(p.items)):
        assert p.describe(seq).startswith(f"#{seq}")
    m = sp.render_map(p)
    assert len(m) == 17 + 3 and "L" not in "".join(m[1:-2]) and "*" in "".join(m)     # home: L 과 착륙 겹침
    big = build(["forward:2", "right:2", "back:2", "left:2"] * 5, max_radius=100)
    assert len(sp.render_map(big)) == 20


# ── mission_seq.monitor 모의 비행 ────────────────────────────────────────

ms = pytest.importorskip("mission_seq", reason="mavsdk 가 없다 (venv 로 돌릴 것)")


class FakeTelem:
    """mission_seq.Telem 이 monitor 에 내주는 것만 흉내 낸다."""

    def __init__(self, plan):
        self.prog = SimpleNamespace(current=0, total=len(plan.items))
        self.pos = SimpleNamespace(latitude_deg=LAT0, longitude_deg=LON0, relative_altitude_m=0.0, absolute_altitude_m=50.0)
        self.vel = SimpleNamespace(north_m_s=0.0, east_m_s=0.0, down_m_s=0.0)
        self.hdg = SimpleNamespace(heading_deg=plan.h0)
        self.in_air = True
        self.rtk_since = None
        self.lost = None

    def current(self):
        return self.prog.current

    def check(self):
        if self.lost:
            raise ms.ModeLost(self.lost)

    def ground_speed(self):
        return math.hypot(self.vel.north_m_s, self.vel.east_m_s)

    def gps_str(self):
        return "fix 3D 위성 12"


async def fly_plan(plan, tm, ticks=6, dt=0.06):
    """FC 흉내: 항목을 차례로 수행 — 웨이포인트는 ticks 번에 걸쳐 그 점으로 간다."""
    for seq, it in enumerate(plan.items):
        tm.prog.current = seq
        if it.command == sp.NAV_TAKEOFF:
            tm.pos.relative_altitude_m = plan.cfg.altitude
        if it.command in (sp.NAV_WAYPOINT, sp.NAV_LAND):
            lat0, lon0 = tm.pos.latitude_deg, tm.pos.longitude_deg
            lat1, lon1 = it.x / 1e7, it.y / 1e7
            h0 = tm.hdg.heading_deg
            dh = (it.param4 - h0 + 180.0) % 360.0 - 180.0             # PX4 처럼 최단 방향
            for i in range(1, ticks + 1):
                await asyncio.sleep(dt)                                 # 항목이 바뀐 직후에는 아직 그 자리 · 그 기수
                tm.pos.latitude_deg = lat0 + (lat1 - lat0) * i / ticks
                tm.pos.longitude_deg = lon0 + (lon1 - lon0) * i / ticks
                tm.vel.north_m_s = 1.0 if i < ticks else 0.0
                tm.hdg.heading_deg = (h0 + dh * i / ticks) % 360.0
            await asyncio.sleep(dt)
        else:
            await asyncio.sleep(dt)
    tm.pos.relative_altitude_m = 0.0
    tm.in_air = False


def run_monitor(plan, tmp_path, monkeypatch, args=None):
    cap = tmp_path / "CAP_ON"
    monkeypatch.setattr(ms, "CAP", cap)
    lines = []
    monkeypatch.setattr(ms, "log", lambda *x: lines.append(" ".join(str(i) for i in x)))
    args = args or SimpleNamespace(accept_radius=plan.cfg.accept_radius, rtk_min=0.0)
    tm = FakeTelem(plan)
    cap_seen = []

    async def watch_cap():
        while True:
            cap_seen.append((tm.prog.current, cap.exists()))
            await asyncio.sleep(0.02)

    async def main():
        w = asyncio.create_task(watch_cap())
        f = asyncio.create_task(fly_plan(plan, tm))
        try:
            return await ms.monitor(None, tm, plan, args)
        finally:
            w.cancel()
            await f
    logs = asyncio.run(main())
    return logs, lines, cap_seen, cap


def test_monitor_steps_and_landing(tmp_path, monkeypatch):
    plan = build(["right:3", "forward:1", "cw:90", "hover:1"], h0=20)
    logs, lines, cap_seen, cap = run_monitor(plan, tmp_path, monkeypatch)
    starts = [l.split()[1] for l in lines if l.startswith("STEP") and " START " in l]
    ends = [l.split()[1] for l in lines if l.startswith("STEP") and " END " in l]
    assert starts == ends == ["1/4", "2/4", "3/4", "4/4"]
    assert lines[-1] == "[확인] 착륙 완료 ✔"
    assert all(s.err_m < 0.05 and s.err_deg < 0.5 for s in logs)        # 모의 FC 는 목표점에 정확히 간다
    assert not any(on for _, on in cap_seen) and not cap.exists()        # 캡처 단계 없음
    assert any(l.startswith("[미션] 진행 #3") for l in lines)


def test_monitor_capture_move_ends_at_target(tmp_path, monkeypatch):
    plan = build(["forward:4+cap", "right:2", "cw:90+cap"], h0=0)
    _, lines, cap_seen, cap = run_monitor(plan, tmp_path, monkeypatch)
    caps = [l for l in lines if l.startswith("CAP")]
    assert [c.split()[:3] for c in caps] == [["CAP", "1", "START"], ["CAP", "1", "END"], ["CAP", "1", "SUMMARY"],
                                             ["CAP", "3", "START"], ["CAP", "3", "END"], ["CAP", "3", "SUMMARY"]]
    assert caps[2].endswith("rtk=OFF") and "cross-track" in caps[2] and "cross-track" not in caps[5]
    move1 = plan.geo[0].last_seq
    on_during = {cur for cur, on in cap_seen if on}
    assert move1 in on_during and plan.roles.index(("rest", 1)) not in on_during         # 쉼 동안은 끔
    assert not any(plan.roles[c][1] == 2 for c in on_during if 0 <= c < len(plan.roles) and plan.roles[c][0] != "rest")
    # 이동 캡처는 X 도달(반경 안)에서 끈다 — 항목이 넘어가기 전(정지 비행 전)
    assert lines.index(next(l for l in lines if l.startswith("CAP 1 END"))) < \
        lines.index(next(l for l in lines if l.startswith(f"[미션] 진행 #{move1 + 1}")))
    assert not cap.exists()


def test_monitor_mode_lost_turns_capture_off(tmp_path, monkeypatch):
    plan = build(["forward:4+cap"], h0=0)
    cap = tmp_path / "CAP_ON"
    monkeypatch.setattr(ms, "CAP", cap)
    monkeypatch.setattr(ms, "log", lambda *x: None)
    tm = FakeTelem(plan)
    args = SimpleNamespace(accept_radius=0.5, rtk_min=0.0)

    async def main():
        async def interfere():
            tm.prog.current = plan.geo[0].last_seq            # 캡처 이동 중
            await asyncio.sleep(0.2)
            assert cap.exists()
            tm.lost = "POSCTL"                                  # 조종기 개입
        t = asyncio.create_task(interfere())
        with pytest.raises(ms.ModeLost):
            await ms.monitor(None, tm, plan, args)
        await t
    asyncio.run(main())
    assert not cap.exists()


def test_monitor_ignores_stale_land_progress(tmp_path, monkeypatch):
    """이전 미션의 묵은 진행 번호(LAND)·in_air=False 로 바로 착륙 판정하지 않는다."""
    plan = build(["right:2"])
    tm = FakeTelem(plan)
    tm.prog.current, tm.in_air = plan.land_seq, False
    monkeypatch.setattr(ms, "log", lambda *x: None)

    async def main():
        task = asyncio.create_task(ms.monitor(None, tm, plan, SimpleNamespace(accept_radius=0.5, rtk_min=0.0)))
        await asyncio.sleep(0.3)
        assert not task.done()
        task.cancel()
    asyncio.run(main())


def test_mission_items_convert():
    p = build(["right:3"])
    items = ms.mission_items(p)
    assert all(ms.same_item(a, b) for a, b in zip(items, p.items))
    assert items[3].param4 == p.items[3].param4 and items[3].x == p.items[3].x


def test_cli_parses_and_rejects(tmp_path):
    ap = ms.build_parser()
    args = ap.parse_args(["--step", "right:3", "--step", "앞 1", "--land", "home", "--yes"])
    preview = ms.resolve_args(ap, args)
    assert preview.preview and preview.key() == "v1|alt=5|spd=1|land=home|right:3;forward:1"
    f = tmp_path / "m.json"
    f.write_text('{"altitude": 7, "land": "home", "steps": ["cw:90", {"kind": "앞", "value": 2, "capture": true}]}',
                 encoding="utf-8")
    args = ap.parse_args(["--mission", str(f), "--altitude", "6", "--yes"])
    preview = ms.resolve_args(ap, args)
    assert preview.key() == "v1|alt=6|spd=1|land=home|cw:90;forward:2+cap"          # 명령줄이 파일보다 앞선다
    with pytest.raises(SystemExit) as e:
        ms.resolve_args(ap, ap.parse_args(["--step", "right:3", "--mission", str(f), "--yes"]))
    assert e.value.code == 2
