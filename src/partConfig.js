/**
 * partConfig.js
 * Fetches component config (label, description, price, gst_percent) from Supabase.
 * Falls back to hardcoded defaults if the table is empty or unavailable.
 * getPrice() always returns the GST-inclusive price used in the configurator.
 */

const DEFAULTS = {
  frame: {
    label: "Rectangular Frame",
    description:
      "Structural base of the robot. Connects to other frames and supports motors.",
    price: 1200,
    gst_percent: 18,
  },
  motor: {
    label: "Motor Housing",
    description:
      "Drive unit for wheels. Must be attached to a Rectangular Frame socket.",
    price: 2500,
    gst_percent: 18,
  },
  triangle_frame: {
    label: "Triangular Frame",
    description:
      "Angular brace for structural support. Attaches to frame sockets.",
    price: 650,
    gst_percent: 18,
  },
  support_frame: {
    label: "Stress Bridge",
    description:
      "Cross-bridge connecting two Triangle Frames. Requires 2 placed triangles.",
    price: 900,
    gst_percent: 18,
  },
  wheel: {
    label: "Wheel",
    description: "Motor-driven wheel assembly. Attaches to a Motor Housing.",
    price: 1100,
    gst_percent: 18,
  },
};

let _cache = JSON.parse(JSON.stringify(DEFAULTS));
let _loaded = false;
let _realtimeChannel = null;

export async function getPartConfig(supabase) {
  try {
    const { data, error } = await supabase
      .from("part_config")
      .select("part_type, label, description, price, gst_percent");

    if (error) {
      console.warn("[partConfig] DB error, using defaults:", error.message);
      return { ..._cache };
    }
    if (!data || data.length === 0) {
      console.warn("[partConfig] Empty table, using defaults.");
      return { ..._cache };
    }

    for (const row of data) {
      _cache[row.part_type] = {
        label: row.label ?? DEFAULTS[row.part_type]?.label ?? row.part_type,
        description:
          row.description ?? DEFAULTS[row.part_type]?.description ?? "",
        price: row.price ?? DEFAULTS[row.part_type]?.price ?? 0,
        gst_percent:
          row.gst_percent ?? DEFAULTS[row.part_type]?.gst_percent ?? 18,
      };
    }
    _loaded = true;
    console.log("[partConfig] Loaded from DB:", Object.keys(_cache));
    return { ..._cache };
  } catch (err) {
    console.warn("[partConfig] Unexpected error, using defaults:", err);
    return { ..._cache };
  }
}

export function subscribePartConfig(supabase, onUpdate) {
  if (_realtimeChannel) {
    supabase.removeChannel(_realtimeChannel);
    _realtimeChannel = null;
  }
  _realtimeChannel = supabase
    .channel("part_config_changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "part_config" },
      async (payload) => {
        console.log("[partConfig] Realtime update:", payload);
        await getPartConfig(supabase);
        if (typeof onUpdate === "function") onUpdate();
      },
    )
    .subscribe();
  return _realtimeChannel;
}

export function unsubscribePartConfig(supabase) {
  if (_realtimeChannel) {
    supabase.removeChannel(_realtimeChannel);
    _realtimeChannel = null;
  }
}

/** Base price before GST */
export function getBasePrice(type) {
  return _cache[type]?.price ?? DEFAULTS[type]?.price ?? 0;
}

/** GST % for a part type */
export function getGST(type) {
  return _cache[type]?.gst_percent ?? DEFAULTS[type]?.gst_percent ?? 18;
}

/** Price INCLUDING GST — used in configurator, basket, orders */
export function getPrice(type) {
  const base = _cache[type]?.price ?? DEFAULTS[type]?.price ?? 0;
  const gst = _cache[type]?.gst_percent ?? DEFAULTS[type]?.gst_percent ?? 18;
  return Math.round(base * (1 + gst / 100));
}

/** Display label */
export function getLabel(type) {
  return (
    _cache[type]?.label ?? DEFAULTS[type]?.label ?? type.replace(/_/g, " ")
  );
}

/** Tooltip description */
export function getDescription(type) {
  return _cache[type]?.description ?? DEFAULTS[type]?.description ?? "";
}

/** Full meta { label, description, price, gst_percent } */
export function getPartMeta(type) {
  return {
    ...(_cache[type] ??
      DEFAULTS[type] ?? {
        label: type,
        description: "",
        price: 0,
        gst_percent: 18,
      }),
  };
}

/** GST-inclusive prices: { frame: 1416, motor: 2950, ... } */
export function getAllPrices() {
  const out = {};
  for (const type of Object.keys(_cache)) {
    const base = _cache[type].price ?? 0;
    const gst = _cache[type].gst_percent ?? 18;
    out[type] = Math.round(base * (1 + gst / 100));
  }
  return out;
}

/** Labels map: { frame: "Rectangular Frame", ... } */
export function getAllLabels() {
  const out = {};
  for (const type of Object.keys(_cache))
    out[type] = _cache[type].label ?? type;
  return out;
}

/** Tooltip HTML with base + GST breakdown */
export function buildTooltipHTML(partType, requiresHint = null) {
  const meta = getPartMeta(partType);
  const final = getPrice(partType);
  const lines = [
    `<strong>${meta.label}</strong>`,
    meta.description,
    requiresHint
      ? `<span style="color:#8aacbf;font-size:10px">${requiresHint}</span>`
      : null,
    `<span style="color:#888;font-size:10px">₹${meta.price.toLocaleString("en-IN")} + ${meta.gst_percent}% GST</span>`,
    `<span style="color:#d05818;font-weight:700">₹${final.toLocaleString("en-IN")} incl. GST</span>`,
  ];
  return lines.filter(Boolean).join("<br>");
}
