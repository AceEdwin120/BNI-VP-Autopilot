# 紅黃綠燈狀態 (Power of One)

## 全員列表

```dataview
TABLE WITHOUT ID
    file.link AS "會員",
    chapter AS "分會",
    traffic_light AS "燈號",
    referrals_given_6mo AS "轉介(給)",
    referrals_received_6mo AS "轉介(收)",
    visitors_brought_6mo AS "來賓帶入",
    last_121 AS "最後 1-to-1"
FROM "wiki/members"
WHERE type = "member" AND status = "active"
SORT traffic_light ASC, name ASC
```

## 🔴 紅燈 (需關心)

```dataview
LIST file.link
FROM "wiki/members"
WHERE type = "member" AND traffic_light = "red"
```

## ⚫ 黑燈 (警戒)

```dataview
LIST file.link
FROM "wiki/members"
WHERE type = "member" AND traffic_light = "black"
```
