# {{sweepName}} sweep — {{date}}

**Corpus:** {{corpusSummary}}
**Primary metric:** {{primaryMetric}}

## Points

| {{knob1}} | {{knob2}} | recallAt5 | precisionAt3 | mrr | p50 | p95 |
|---|---|---|---|---|---|---|
{{#points}}
| {{k1}} | {{k2}} | {{recallAt5}} | {{precisionAt3}} | {{mrr}} | {{p50}} | {{p95}} |
{{/points}}

## Heatmap (primary = {{primaryMetric}})

               {{knob2}}
{{heatmapHeader}}
{{knob1}}
{{heatmapRows}}

## Elbow

**Recommended overrides:** `{{elbowOverrides}}`
**Rationale:** {{elbowRationale}}

## Spec amendment proposal

{{amendmentText}}

## Environment snapshot

```json
{{envSnapshot}}
```
