import { useEffect, useRef } from "react";
import { Slider, Switch, Tooltip, Typography } from "@arco-design/web-react";
import { IconQuestionCircle } from "@arco-design/web-react/icon";
import { PARAM_DEFS, type ParamGroup, type ParamValues } from "../params/schema";

interface ParamSlidersProps {
  group: ParamGroup;
  params: ParamValues;
  onChange: (key: string, value: number) => void;
}

// schema 驱动的参数列表：PARAM_DEFS 里加一条定义，这里自动多一行
export function ParamSliders({ group, params, onChange }: ParamSlidersProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    for (const handle of containerRef.current?.querySelectorAll<HTMLElement>("[data-slider-label] [role=slider]") ?? []) {
      handle.setAttribute("aria-labelledby", handle.closest("[data-slider-label]")?.getAttribute("data-slider-label") ?? "");
    }
  }, [group]);
  const defs = PARAM_DEFS.filter((def) => def.group === group && !(def.kind === "slider" && def.hidden));
  return (
    <div ref={containerRef}>
      {defs.map((def) => (
        <div key={def.key} className="param-row" data-slider-label={def.kind === "slider" ? `param-${def.key}` : undefined}>
          <div className="param-head">
            <span className="param-label">
              <Typography.Text id={`param-${def.key}`}>{def.label}</Typography.Text>
              {def.description && (
                <Tooltip content={def.description}>
                  <button type="button" className="param-help" aria-label={`${def.label}说明`}>
                    <IconQuestionCircle aria-hidden="true" />
                  </button>
                </Tooltip>
              )}
            </span>
            {def.kind === "slider" && (
              <Typography.Text type="secondary">
                {params[def.key].toFixed(Math.max(2, (def.step.toString().split(".")[1] ?? "").length))}
                {def.unit ?? ""}
              </Typography.Text>
            )}
          </div>
          {def.kind === "switch" ? (
            <Switch
              aria-label={def.label}
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
