import { Slider, Switch, Typography } from "@arco-design/web-react";
import { PARAM_DEFS, type ParamGroup, type ParamValues } from "../params/schema";

interface ParamSlidersProps {
  group: ParamGroup;
  params: ParamValues;
  onChange: (key: string, value: number) => void;
}

// schema 驱动的参数列表：PARAM_DEFS 里加一条定义，这里自动多一行
export function ParamSliders({ group, params, onChange }: ParamSlidersProps) {
  const defs = PARAM_DEFS.filter((def) => def.group === group);
  return (
    <div>
      {defs.map((def) => (
        <div key={def.key} className="param-row">
          <div className="param-head">
            <Typography.Text>{def.label}</Typography.Text>
            {def.kind === "slider" && (
              <Typography.Text type="secondary">
                {params[def.key].toFixed(2)}
                {def.unit ?? ""}
              </Typography.Text>
            )}
          </div>
          {def.kind === "switch" ? (
            <Switch
              checked={params[def.key] > 0.5}
              onChange={(checked) => onChange(def.key, checked ? 1 : 0)}
            />
          ) : (
            <Slider
              min={def.min}
              max={def.max}
              step={def.step}
              value={params[def.key]}
              onChange={(value) => onChange(def.key, Array.isArray(value) ? value[0] : value)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
