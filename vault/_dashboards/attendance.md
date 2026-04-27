# 近期出席狀況

```dataview
TABLE
    date AS "日期",
    chapter AS "分會",
    present_count AS "出席",
    late_count AS "遲到",
    absent_count AS "缺席",
    early_leave_count AS "早退"
FROM "wiki/meetings"
WHERE type = "meeting"
SORT date DESC
LIMIT 20
```

## 缺席次數最多的會員 (近 6 個月)

```dataview
TABLE WITHOUT ID
    file.link AS "會員",
    chapter AS "分會",
    traffic_light AS "燈號"
FROM "wiki/members"
WHERE type = "member" AND status = "active"
SORT traffic_light ASC
```
