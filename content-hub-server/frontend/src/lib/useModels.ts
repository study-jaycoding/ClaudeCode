// 모델/파라미터/비용 로직 — SpotlightPrompt 본문에서 그대로 추출한 커스텀 훅.
//  · 훅 호출 순서·effect deps 를 SpotlightPrompt 와 동일하게 유지(동작 100% 보존).
//  · 모델 로드 실패 시 주입받은 onError 로 보고(기존 setError 자리).
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ModelInfo, ModelParam, ModelParamsOut } from "../types";

// 노출 모델 화이트리스트(타입별, 표시 순서대로).
//  이미지: Nano Banana 2(nano_banana_flash) · Nano Banana Pro(nano_banana_2) · GPT Image 2(gpt_image_2)
//  비디오: Seedance 2.0(seedance_2_0)
// 각 모델의 옵션은 CLI 스키마(get_model_params)로 동적 렌더 — 모델마다 다른 파라미터 자동 반영.
export const ALLOWED: Record<"image" | "video", string[]> = {
  image: ["nano_banana_flash", "nano_banana_2", "gpt_image_2"],
  video: ["seedance_2_0"],
};
// 동적 옵션에서 제외(프롬프트·미디어·내부용)
export const HIDDEN_PARAMS = new Set(["prompt", "medias", "input_images", "folder_id"]);

export function useModels(onError: (msg: string) => void) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [type, setType] = useState<"image" | "video">("image");
  const [model, setModel] = useState("");
  const [params, setParams] = useState<ModelParam[]>([]);
  const [optionValues, setOptionValues] = useState<Record<string, string | number>>({});
  const [cost, setCost] = useState<number | null>(null);
  const [costLoading, setCostLoading] = useState(false);
  // 카드 드롭 복원 시: 모델 변경 effect 가 기본값으로 옵션을 덮어쓰기 전, 복원할 옵션을 임시 보관.
  const pendingOptsRef = useRef<Record<string, string | number> | null>(null);
  // 모델별 파라미터 캐시 — 이미지/비디오 토글 시 재요청(네트워크) 없이 즉시 전환.
  const paramsCacheRef = useRef<Record<string, ModelParamsOut>>({});
  // 드롭다운 닫기 브리지 — open/setOpen 은 컴포넌트 UI 상태로 남으므로,
  // setOpt 가 옵션 선택 후 드롭다운을 닫도록 컴포넌트가 setOpen 을 여기 등록한다.
  const setOpenRef = useRef<((v: string | null) => void) | null>(null);

  // 화이트리스트 모델만 노출(타입별 다중, 화이트리스트 순서 유지).
  const typeModels = ALLOWED[type]
    .map((jt) => models.find((m) => m.job_set_type === jt))
    .filter((m): m is ModelInfo => !!m);
  const modelName =
    models.find((m) => m.job_set_type === model)?.display_name || "모델 선택";
  // 동적 옵션으로 보여줄 파라미터(프롬프트·미디어 제외)
  const tunable = params.filter((p) => !HIDDEN_PARAMS.has(p.name));

  useEffect(() => {
    api.models().then(setModels).catch((e) => onError(String(e)));
  }, []);

  useEffect(() => {
    if (!typeModels.length) return;
    if (!typeModels.some((m) => m.job_set_type === model)) {
      setModel(typeModels[0].job_set_type);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, models]);

  // 모델 바뀌면 CLI 파라미터 로드 + 기본값으로 옵션 초기화.
  useEffect(() => {
    if (!model) {
      setParams([]);
      setOptionValues({});
      return;
    }
    // 파라미터 → params + 기본값 옵션 적용. 드롭 복원이 대기 중이면 기본값 위에 덮음.
    const apply = (r: ModelParamsOut) => {
      setParams(r.params);
      const init: Record<string, string | number> = {};
      for (const p of r.params) {
        if (HIDDEN_PARAMS.has(p.name)) continue;
        if (p.default != null) init[p.name] = p.default as string | number;
        else if (p.enum?.length) init[p.name] = p.enum[0];
      }
      if (pendingOptsRef.current) {
        setOptionValues({ ...init, ...pendingOptsRef.current });
        pendingOptsRef.current = null;
      } else {
        setOptionValues(init);
      }
    };
    // 캐시 적중 → 네트워크 없이 즉시 적용(토글 딜레이 제거).
    const cached = paramsCacheRef.current[model];
    if (cached) {
      apply(cached);
      return;
    }
    let alive = true;
    api
      .modelParams(model)
      .then((r) => {
        paramsCacheRef.current[model] = r;
        if (alive) apply(r);
      })
      .catch(() => {
        if (alive) {
          setParams([]);
          setOptionValues({});
        }
      });
    return () => {
      alive = false;
    };
  }, [model]);

  // 두 모델(이미지/비디오) 파라미터를 미리 받아 캐시 → 첫 토글부터 즉시 전환.
  useEffect(() => {
    for (const m of [...ALLOWED.image, ...ALLOWED.video]) {
      if (paramsCacheRef.current[m]) continue;
      api
        .modelParams(m)
        .then((r) => {
          paramsCacheRef.current[m] = r;
        })
        .catch(() => {});
    }
  }, []);

  // 모델/옵션 바뀌면 예상 크레딧 재추정(debounce 250ms).
  useEffect(() => {
    if (!model) {
      setCost(null);
      return;
    }
    let alive = true;
    setCostLoading(true);
    const t = window.setTimeout(() => {
      api
        .estimateCost(model, optionValues)
        .then((r) => alive && (setCost(r.credits), setCostLoading(false)))
        .catch(() => alive && (setCost(null), setCostLoading(false)));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [model, optionValues]);

  const setOpt = (name: string, value: string | number) => {
    setOptionValues((prev) => ({ ...prev, [name]: value }));
    setOpenRef.current?.(null);
  };

  return { models, type, setType, model, setModel, params, tunable, typeModels, modelName,
           optionValues, setOptionValues, setOpt, cost, costLoading, pendingOptsRef, setOpenRef };
}
