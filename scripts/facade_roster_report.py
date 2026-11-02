"""Generate the reviewable, source-linked facade roster from its runtime JSON.

Run after export to include application diagnostics: python scripts/facade_roster_report.py
"""
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    roster = json.loads((ROOT / "docs/facade-color-roster.json").read_text(encoding="utf-8"))
    meta = json.loads((ROOT / "web/public/data/meta.json").read_text(encoding="utf-8"))
    diagnostics = {d["key"]: d for d in meta.get("facadeDiagnostics", [])}
    esc = lambda value: html.escape(str(value))
    cards = []
    for e in roster["entries"]:
        d = diagnostics.get(e["key"], {})
        status = d.get("status", e["status"])
        identity = e.get("identity", {})
        source_links = " · ".join(f'<a href="{esc(s)}">Source {i+1}</a>' for i, s in enumerate(e.get("sources", [])))
        color = e.get("color", "#cccccc")
        current = e.get("beforeColor", "#cccccc")
        cards.append(f'''<article data-status="{esc(e['status'])}"><h3>{esc(e['name'])}</h3>
          <p class="status">{esc(status)} {('· '+str(d['cells'])+' footprint cells') if d.get('cells') else ''}</p>
          <div class="swatches"><div><i style="background:{esc(current)}"></i>Before <code>{esc(current)}</code></div>
          <div><i style="background:{esc(color)}"></i>Target <code>{esc(color)}</code></div></div>
          <p>{esc(e.get('evidence', ''))}</p><p class="muted">{esc(e.get('notes', ''))}</p>
          <p>{source_links}</p><small>{esc(identity.get('type','unmatched'))} {esc(identity.get('id',''))} · {esc(e.get('material','pending'))} · {esc(e.get('confidence','provisional'))}</small></article>''')
    verified = sum(e["status"] == "verified" for e in roster["entries"])
    applied = sum(d["status"] == "applied" for d in diagnostics.values())
    page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>DTLA checked facade roster</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f3f0e9;color:#293334;font:16px/1.6 system-ui}main{max-width:1200px;margin:auto;padding:36px 24px}h1{font-size:42px;line-height:1.15}h3{margin:0;font-size:21px}p{max-width:960px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}article{padding:22px;background:#fffdf8;border:1px solid #dedbd3;border-radius:12px}a{color:#37666d}.muted,small{color:#606864}.status{font-size:13px;color:#37666d}.swatches{display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px}.swatches i{display:block;height:65px;border-radius:5px;border:1px solid #0001}code{display:block}button{padding:9px 15px;margin:0 8px 18px 0;background:#fffdf8;border:1px solid #aaa;border-radius:6px;cursor:pointer}button[aria-pressed=true]{background:#37666d;color:white}[hidden]{display:none!important}@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:560px){.grid{grid-template-columns:1fr}}@media print{article{break-inside:avoid}}
    </style><main><p>DTLA / facade color normalization / 2026-11-02</p><h1>A checked roster, not a citywide recolor.</h1>'''
    page += f'<p><strong>{len(cards)} buildings reviewed · {verified} verified entries · {applied} applied in the current export.</strong></p>'
    page += '''<p>Preserve the warm city mood and generic palette variety. Correct known cladding and glazing, including distinctive turquoise, coral granite, dark bronze and pale stone. Hex values are coordinated artistic adaptations of material evidence, not measured physical albedos. “Verified” describes the evidence and footprint match, not a calibrated color measurement.</p>
    <p>Before swatches show the dominant exported facade palette within the checked footprint; targets are pre-quantization inputs. Sunlight, reflections and tone mapping affect rendered appearance. Provisional records remain visible here but do not alter tiles. Mixed-material buildings use a dominant facade treatment unless already supported by a landmark shader; detailed zoning remains follow-up work.</p>
    <p>Existing landmark geometry, facade patterns, nighttime illumination and aircraft warning lights are preserved. This is a working roster of recognizable buildings, not a claim to cover every historic designation.</p>
    <button data-filter="all" aria-pressed="true">All buildings</button><button data-filter="verified" aria-pressed="false">Verified</button><button data-filter="provisional" aria-pressed="false">Needs more evidence</button><div class="grid">'''
    page += "".join(cards)
    page += '''</div><p><a href="facade-color-roster.json">Runtime roster and evidence (JSON)</a> · <a href="facade-color-proposal.html">Original palette proposal</a></p></main><script>
    document.querySelectorAll('button').forEach(b=>b.onclick=()=>{document.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));document.querySelectorAll('article').forEach(a=>a.hidden=b.dataset.filter!=='all'&&a.dataset.status!==b.dataset.filter)});
    </script></html>'''
    (ROOT / "docs/facade-color-roster.html").write_text(page, encoding="utf-8")
    print(f"Roster report: {len(cards)} reviewed, {verified} verified, {applied} applied")


if __name__ == "__main__":
    main()
