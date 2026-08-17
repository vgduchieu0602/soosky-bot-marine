
import concurrent.futures, json, urllib.request, urllib.error
from pathlib import Path
TOKEN = 'reality-internal-token'
BASE = "http://127.0.0.1:3200"
out = Path(r"C:/Code/Project/Soosky-backend/Marine/Crawl-Marine-Bot/tmp")

def post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json", "X-Internal-Token": TOKEN},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}

s, body = post("/internal/vessels/111000001/acquire", {
    "need": "DETAIL",
    "allowPaidFallback": False,
    "acquisitionRequestId": "acq-local-0001",
})
print("FREE", s, body.get("status"), body.get("sourceUsed"), body.get("fallbackUsed"), body.get("externalAttempted"), body.get("acquisitionRequestId"))
(out/"acq1.json").write_text(json.dumps(body, indent=2), encoding="utf-8")

body_id = {
    "need": "POSITION",
    "allowPaidFallback": False,
    "acquisitionRequestId": "acq-idem-9999",
}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
    results = list(ex.map(lambda _: post("/internal/vessels/111000001/acquire", body_id), range(2)))
print("IDEM", [(st, b.get("status"), b.get("durationMs"), b.get("acquisitionRequestId")) for st,b in results])
(out/"acq-idem.json").write_text(json.dumps({"a": results[0][1], "b": results[1][1]}, indent=2), encoding="utf-8")

s1,b1 = post("/internal/vessels/111000001/acquire", {"need":"POSITION","allowPaidFallback":False,"acquisitionRequestId":"acq-diff-0001"})
s2,b2 = post("/internal/vessels/111000001/acquire", {"need":"POSITION","allowPaidFallback":False,"acquisitionRequestId":"acq-diff-0002"})
print("DIFF", s1, b1.get("status"), b1.get("sourceUsed"), b1.get("fallbackUsed"), "|", s2, b2.get("status"), b2.get("sourceUsed"), b2.get("fallbackUsed"))
print("DONE")
