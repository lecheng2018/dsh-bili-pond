#!/usr/bin/env python3
"""广告 / 引流小号过滤测试（_screen_video）。

不导入 MCP / bilibili-api，只从真实 mcp_server.py 里抽出规则函数执行，
所以既测的是生产代码，又不需要网络、登录态或第三方依赖。

覆盖四类：
  1. 正常视频不误伤（GitHub / B站短链 / 微博链接、空简介）
  2. 明显广告（优惠 / 秒杀 / 广告合作）
  3. 引流小号（短链 / 裸链接 / 资源+网盘 / 网盘+联系方式）
  4. 自定义屏蔽词（words 参数）+ 时长格式化（_sec_to_dur）
"""
import ast
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "vendor" / "bilibili-mcp" / "mcp_server.py"
tree = ast.parse(SRC.read_text(encoding="utf-8"), filename=str(SRC))

wanted = {
    "_ADS_WORDS", "_RESOURCE_WORDS", "_NETDISK_WORDS", "_CONTACT_WORDS",
    "_SHORTLINK_HOSTS", "_SPAM_TLDS", "_URL_TRUSTED_HOSTS", "_URL_RE",
    "_url_hosts", "_screen_video", "_sec_to_dur", "_feed_items",
}
nodes = []
for node in tree.body:
    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in wanted for t in node.targets):
        nodes.append(node)
    elif isinstance(node, ast.FunctionDef) and node.name in wanted:
        nodes.append(node)

assert len(nodes) == len(wanted), f"应从真实源码抽出 {len(wanted)} 个过滤节点，实际 {len(nodes)}"
module = ast.Module(body=[ast.Import(names=[ast.alias(name="re")])] + nodes, type_ignores=[])
ast.fix_missing_locations(module)
ns = {}
exec(compile(module, str(SRC), "exec"), ns)
screen = ns["_screen_video"]
dur = ns["_sec_to_dur"]

# words=() ：不测自定义屏蔽词的用例都传空（真实代码里 None 会落到 env 下发的默认词）
W0 = {"words": ()}

# ── 1. 正常视频：一条都不该挡 ──
passed = [
    ("OpenWrt NSS 固件编译教程", "这期讲怎么用 Lean 的源码编译，仓库见 https://github.com/coolsnowwolf/lede", ""),
    ("NAS 折腾日记", "https://github.com/foo/bar", ""),                       # 简介只有一条可信裸链接
    ("机械键盘选购指南", "", ""),                                            # 空简介
    ("我的视频更新了", "合集都在这 https://b23.tv/abc123", ""),              # B站官方短链 ≠ 引流短链
    ("周末出门拍了拍", "微博同名：https://weibo.com/u/123456", ""),          # 常见平台外链
    ("Python 入门第 3 课", "代码地址见简介", ""),                            # 提到「简介」但没链接
]
for title, desc, author in passed:
    hit = screen(title, desc, author, **W0)
    assert hit is None, f"不该挡的正常视频：{title!r} / {desc!r} ⇒ {hit}"

# ── 2. 明显广告 ──
ads_cases = [
    ("全平台最低价代购攻略", "优惠券点击领取，秒杀价不等人", ""),
    ("新手机开箱", "商务合作请私信，广告合作看主页", ""),
]
for title, desc, author in ads_cases:
    hit = screen(title, desc, author, **W0)
    assert hit is not None and hit[0] == "ads", f"应挡成广告：{title!r} ⇒ {hit}"

# ── 3. 引流小号 ──
spam_cases = [
    # 简介挂短链（用户实测最烦的那类）
    ("学习资料整理", "链接 https://t.cn/abc123 领取", ""),
    # 可疑 TLD
    ("分享一个工具", "下载地址 https://xxx-res.xyz/123", ""),
    # 简介只有一条裸链接，没有别的内容
    ("某工具教程", "https://pan-download.net/xyz", ""),
    # 资源分享口吻 + 网盘/联系方式 —— 引流小号标准画像
    ("Python 全套教程资源免费分享", "需要的加v：abc123，百度网盘自取", ""),
    ("ps ai pr 教程资料", "关注公众号 xxx，夸克网盘领取", ""),
    # 网盘 + 联系方式同时出现（标题不 Nab 资源词也挡）
    ("我的开发日常", "资料在夸克网盘：xxx，需要的私信我", ""),
]
for title, desc, author in spam_cases:
    hit = screen(title, desc, author, **W0)
    assert hit is not None and hit[0] == "spam", f"应挡成引流：{title!r} / {desc!r} ⇒ {hit}"

# ── 4. 自定义屏蔽词 + 时长格式化 ──
hit = screen("原神最新版本解析", "本期讲新地图", "", words=("原神",))
assert hit is not None and hit[0] == "word", f"自定义屏蔽词应生效：{hit}"
assert screen("正常视频", "正文提了一句原神", "", words=("崩铁",)) is None, "屏蔽词不该跨条目误伤"

assert dur(93) == "1:33", dur(93)
assert dur(3725) == "1:02:05", dur(3725)
assert dur(45) == "0:45", dur(45)
assert dur(None) == "0:00", dur(None)

# ── 5. 推荐流响应归一（_feed_items）：两种口径 + 广告卡过滤 ──
feed_items = ns["_feed_items"]
video = lambda bv, goto=None: {"bvid": bv, "title": "t", **({"goto": goto} if goto else {})}
# 老口径：data 直接是数组；无 goto 的普通卡要收，广告卡(cm)/番剧卡要丢，没 bvid 的要丢
old_style = [video("BV1old1"), video("BVad", "cm"), video("BVbg", "bangumi"), {"title": "no bvid"}, "垃圾条目"]
got = feed_items(old_style)
assert [v["bvid"] for v in got] == ["BV1old1"], f"老口径归一不对：{got}"
# 新口径：{"items": [...]}，goto=av 的收
new_style = {"items": [video("BVnew1", "av"), video("BVnew2", "av")]}
assert [v["bvid"] for v in feed_items(new_style)] == ["BVnew1", "BVnew2"], "新口径归一不对"
assert feed_items(None) == [] and feed_items(42) == [] and feed_items({}) == [], "异常输入应给空列表"

print(f"[OK] feed filter tests: {len(passed) + len(ads_cases) + len(spam_cases) + 10} cases")
