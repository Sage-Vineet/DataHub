import { useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Download,
  ImagePlus,
  Loader2,
  Palette,
  Plus,
  RefreshCcw,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  CIM_STYLE_COLOR_FIELDS,
  CIM_STYLE_TRANSITION_OPTIONS,
  DEFAULT_CIM_STYLE_COLORS,
  DEFAULT_CIM_STYLE_PROFILE_ID,
  SUPPORTED_CIM_STYLE_FONTS,
  createCimStyleProfile,
  exportCimStyleProfileJson,
  importCimStyleProfileJson,
  normalizeCimStyleProfile,
  normalizeCimStyleProfilesState,
  validateCimStyleProfile,
} from "../../lib/cimTemplateStyleProfiles";

const EDITOR_TABS = [
  { key: "colors", label: "Colors" },
  { key: "fonts", label: "Fonts" },
  { key: "background", label: "Background" },
  { key: "tables", label: "Tables" },
  { key: "charts", label: "Charts" },
  { key: "branding", label: "Branding" },
];

const DEFAULT_PREVIEW_SLIDES = Array.from({ length: 38 }, (_, index) => index + 1);
const DEFAULT_COLOR_PRESETS = [
  "#476E2C",
  "#8BC53D",
  "#243F18",
  "#050505",
  "#333333",
  "#6D6E71",
  "#A5A5A5",
  "#E5E7EB",
  "#EEF6E0",
  "#F7F8FA",
  "#FFFFFF",
  "#0563C1",
];

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

function downloadText(filename, text, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function slugify(value) {
  return String(value || "cim-style-profile")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "cim-style-profile";
}

function normalizePickerHex(value, fallback = "#000000") {
  const match = String(value || "").trim().match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toUpperCase()}` : fallback;
}

function updateNested(object, path, value) {
  const [head, ...rest] = path;
  if (!head) return value;
  return {
    ...(object || {}),
    [head]: rest.length ? updateNested(object?.[head], rest, value) : value,
  };
}

function ControlLabel({ children }) {
  return (
    <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
      {children}
    </span>
  );
}

function NumberInput({ value, min, max, step = 1, onChange }) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 w-full rounded-md border border-border bg-white px-2.5 text-xs font-semibold text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
    />
  );
}

function SelectInput({ value, onChange, children }) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 w-full rounded-md border border-border bg-white px-2.5 text-xs font-semibold text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
    >
      {children}
    </select>
  );
}

function ToggleInput({ checked, onChange, label }) {
  return (
    <label className="inline-flex min-h-9 items-center gap-2 rounded-md border border-border bg-white px-2.5 text-xs font-semibold text-[#050505]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-[#476E2C]"
      />
      {label}
    </label>
  );
}

function ColorInput({
  label,
  value,
  onChange,
  presetColors = DEFAULT_COLOR_PRESETS,
  recentColors = [],
  onColorPicked,
  opacity,
  onOpacityChange,
  opacityLabel = "Opacity",
}) {
  const hex = normalizePickerHex(value);
  const commitColor = (nextValue) => {
    const nextHex = normalizePickerHex(nextValue, "");
    if (!nextHex) return;
    onChange(nextHex);
    onColorPicked?.(nextHex);
  };
  const presets = Array.from(new Set((presetColors || []).map((color) => normalizePickerHex(color, "")).filter(Boolean))).slice(0, 12);
  const recents = Array.from(new Set((recentColors || []).map((color) => normalizePickerHex(color, "")).filter(Boolean))).slice(0, 6);

  return (
    <div className="block">
      <ControlLabel>{label}</ControlLabel>
      <div className="rounded-md border border-border bg-white p-2.5">
        <div className="grid grid-cols-[40px_minmax(0,1fr)] gap-2">
          <input
            type="color"
            value={hex}
            onChange={(event) => commitColor(event.target.value)}
            className="h-9 w-full cursor-pointer rounded border border-border bg-transparent p-1"
            title={`${label} color`}
            aria-label={`${label} color`}
          />
          <input
            key={hex}
            defaultValue={hex}
            onBlur={(event) => commitColor(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitColor(event.currentTarget.value);
                event.currentTarget.blur();
              }
            }}
            className="h-9 min-w-0 rounded-md border border-border px-2 text-xs font-semibold uppercase text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
            aria-label={`${label} HEX`}
          />
        </div>
        {onOpacityChange ? (
          <label className="mt-2 block">
            <span className="mb-1 flex items-center justify-between text-[9px] font-bold uppercase text-[#8A8F98]">
              <span>{opacityLabel}</span>
              <span>{Math.round(Number(opacity ?? 1) * 100)}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={opacity ?? 1}
              onChange={(event) => onOpacityChange(event.target.value)}
              className="w-full accent-[#476E2C]"
            />
          </label>
        ) : null}
        {presets.length ? (
          <div className="mt-2">
            <span className="mb-1 block text-[9px] font-bold uppercase text-[#8A8F98]">Suggested</span>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => commitColor(color)}
                  className={`h-6 w-6 rounded border ${color === hex ? "border-[#050505] ring-2 ring-[#8BC53D]/30" : "border-border"}`}
                  style={{ backgroundColor: color }}
                  title={color}
                  aria-label={`Use ${color}`}
                />
              ))}
            </div>
          </div>
        ) : null}
        {recents.length ? (
          <div className="mt-2">
            <span className="mb-1 block text-[9px] font-bold uppercase text-[#8A8F98]">Recent</span>
            <div className="flex flex-wrap gap-1.5">
              {recents.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => commitColor(color)}
                  className="h-6 w-6 rounded border border-border"
                  style={{ backgroundColor: color }}
                  title={color}
                  aria-label={`Use recent ${color}`}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ImageUploadControl({ label, image, onChange, onError }) {
  const inputRef = useRef(null);

  const handleFile = async (file) => {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/svg+xml", "image/gif", "image/webp"].includes(file.type)) {
      onError("Use PNG, JPG, SVG, GIF, or WEBP.");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      onError("Use an image under 4 MB.");
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      onChange({ dataUrl, name: file.name, mimeType: file.type });
    } catch {
      onError("The selected image could not be read.");
    }
  };

  return (
    <div>
      <ControlLabel>{label}</ControlLabel>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-white px-3 text-xs font-bold text-[#476E2C] transition hover:bg-[#EEF6E0]"
        >
          <ImagePlus size={14} />
          {image?.dataUrl ? "Replace" : "Upload"}
        </button>
        {image?.dataUrl ? (
          <>
            <img src={image.dataUrl} alt={image.name || label} className="h-9 w-16 rounded border border-border object-contain" />
            <button
              type="button"
              onClick={() => onChange(null)}
              className="flex h-9 w-9 items-center justify-center rounded-md text-[#8A8F98] transition hover:bg-red-50 hover:text-red-600"
              aria-label={`Remove ${label}`}
            >
              <Trash2 size={14} />
            </button>
          </>
        ) : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/gif,image/webp"
        className="hidden"
        onChange={(event) => {
          void handleFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </div>
  );
}

function ProfileList({
  state,
  selectedProfileId,
  onSelect,
  onCreate,
  onDuplicate,
  onDelete,
  onReset,
  onImport,
  onExport,
}) {
  const importRef = useRef(null);

  return (
    <aside className="flex min-h-0 flex-col border-r border-border bg-[#F7F8FA]">
      <div className="border-b border-border p-3">
        <button
          type="button"
          onClick={onCreate}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-[#476E2C] px-3 text-xs font-bold text-white transition hover:bg-[#365522]"
        >
          <Plus size={14} />
          New Profile
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {state.profiles.map((profile) => {
          const selected = profile.id === selectedProfileId;
          return (
            <button
              key={profile.id}
              type="button"
              onClick={() => onSelect(profile.id)}
              className={`mb-2 block w-full rounded-md border p-2 text-left transition ${
                selected
                  ? "border-[#8BC53D] bg-white ring-2 ring-[#8BC53D]/20"
                  : "border-border bg-white hover:border-[#BFD99B]"
              }`}
            >
              <span className="block truncate text-xs font-bold text-[#050505]">{profile.name}</span>
              <span className="mt-1 flex items-center gap-1 text-[10px] font-semibold text-[#6D6E71]">
                <span className="h-3 w-3 rounded-full border border-white" style={{ backgroundColor: profile.colors.primary }} />
                <span className="h-3 w-3 rounded-full border border-white" style={{ backgroundColor: profile.colors.secondary }} />
                <span className="h-3 w-3 rounded-full border border-white" style={{ backgroundColor: profile.colors.accent }} />
                {profile.locked ? "Default" : "Custom"}
              </span>
            </button>
          );
        })}
      </div>
      <div className="space-y-2 border-t border-border p-3">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onDuplicate}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border bg-white text-xs font-bold text-[#476E2C] transition hover:bg-[#EEF6E0]"
          >
            <Copy size={13} />
            Duplicate
          </button>
          <button
            type="button"
            onClick={onExport}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border bg-white text-xs font-bold text-[#476E2C] transition hover:bg-[#EEF6E0]"
          >
            <Download size={13} />
            Export
          </button>
          <button
            type="button"
            onClick={() => importRef.current?.click()}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border bg-white text-xs font-bold text-[#476E2C] transition hover:bg-[#EEF6E0]"
          >
            <Upload size={13} />
            Import
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={selectedProfileId === DEFAULT_CIM_STYLE_PROFILE_ID}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border bg-white text-xs font-bold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 size={13} />
            Delete
          </button>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[#BFD99B] bg-white text-xs font-bold text-[#476E2C] transition hover:bg-[#EEF6E0]"
        >
          <RefreshCcw size={13} />
          Reset to Default Template
        </button>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            void onImport(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
    </aside>
  );
}

const CORE_COLOR_FIELDS = new Set(["primary", "secondary", "accent", "background", "title", "body"]);
const TEXT_COLOR_FIELDS = new Set(["subtitle", "muted", "footer", "hyperlink", "highlight"]);

function ColorsTab({ profile, updateProfile, colorPickerProps }) {
  const renderColor = ({ key, label }) => (
    <ColorInput
      key={key}
      label={label}
      value={profile.colors[key]}
      onChange={(value) => updateProfile(["colors", key], value)}
      {...colorPickerProps}
    />
  );
  const coreFields = CIM_STYLE_COLOR_FIELDS.filter(({ key }) => CORE_COLOR_FIELDS.has(key));
  const textFields = CIM_STYLE_COLOR_FIELDS.filter(({ key }) => TEXT_COLOR_FIELDS.has(key));
  const advancedFields = CIM_STYLE_COLOR_FIELDS.filter(({ key }) => !CORE_COLOR_FIELDS.has(key) && !TEXT_COLOR_FIELDS.has(key));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {coreFields.map(renderColor)}
      </div>
      <details className="rounded-md border border-border bg-white p-3">
        <summary className="cursor-pointer text-xs font-bold text-[#476E2C]">More text colors</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {textFields.map(renderColor)}
        </div>
      </details>
      <details className="rounded-md border border-border bg-white p-3">
        <summary className="cursor-pointer text-xs font-bold text-[#476E2C]">Table, chart, and divider colors</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {advancedFields.map(renderColor)}
        </div>
      </details>
    </div>
  );
}

const TEXT_STYLE_GROUPS = [
  { key: "titles", label: "Titles", roles: ["title", "heading", "subheading"] },
  { key: "body", label: "Body", roles: ["body"] },
  { key: "small", label: "Small Text", roles: ["caption", "footer"] },
  { key: "tables", label: "Tables", roles: ["table"] },
];

const TEXT_STYLE_SIZE_PRESETS = {
  compact: {
    title: 0.92,
    heading: 0.94,
    subheading: 0.95,
    body: 0.95,
    caption: 0.94,
    footer: 0.94,
    table: 0.94,
  },
  standard: {
    title: 1,
    heading: 1,
    subheading: 1,
    body: 1,
    caption: 1,
    footer: 1,
    table: 1,
  },
  large: {
    title: 1.08,
    heading: 1.07,
    subheading: 1.06,
    body: 1.05,
    caption: 1.03,
    footer: 1.03,
    table: 1.04,
  },
};

function getSharedRoleValue(profile, roles, key, fallback) {
  const values = roles.map((roleKey) => profile.typography.roles[roleKey]?.[key]).filter((value) => value !== undefined);
  return values.length && values.every((value) => value === values[0]) ? values[0] : fallback;
}

function getTextStyleSizePreset(profile, roles) {
  const scales = roles.map((roleKey) => Number(profile.typography.roles[roleKey]?.sizeScale || 1));
  const average = scales.reduce((sum, value) => sum + value, 0) / Math.max(scales.length, 1);
  if (average <= 0.97) return "compact";
  if (average >= 1.04) return "large";
  return "standard";
}

function FontsTab({ profile, updateProfile }) {
  const updateRoleGroup = (roles, property, value) => {
    roles.forEach((roleKey) => updateProfile(["typography", "roles", roleKey, property], value));
  };
  const updateTextStyleSizePreset = (roles, presetKey) => {
    const preset = TEXT_STYLE_SIZE_PRESETS[presetKey] || TEXT_STYLE_SIZE_PRESETS.standard;
    roles.forEach((roleKey) => {
      const sizeScale = preset[roleKey] || 1;
      updateProfile(["typography", "roles", roleKey, "sizeScale"], sizeScale);
      updateProfile(["typography", "roles", roleKey, "sizeDelta"], 0);
    });
  };

  return (
    <div className="space-y-4">
      {TEXT_STYLE_GROUPS.map((group) => {
        const firstRole = profile.typography.roles[group.roles[0]] || profile.typography.roles.body;
        return (
          <div key={group.key} className="rounded-md border border-border bg-white p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs font-bold text-[#050505]">{group.label}</span>
              <div className="flex gap-2">
                <ToggleInput
                  checked={Boolean(firstRole.bold)}
                  onChange={(value) => updateRoleGroup(group.roles, "bold", value)}
                  label="B"
                />
                <ToggleInput
                  checked={Boolean(firstRole.italic)}
                  onChange={(value) => updateRoleGroup(group.roles, "italic", value)}
                  label="I"
                />
                <ToggleInput
                  checked={Boolean(firstRole.underline)}
                  onChange={(value) => updateRoleGroup(group.roles, "underline", value)}
                  label="U"
                />
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <label>
                <ControlLabel>Font</ControlLabel>
                <SelectInput
                  value={getSharedRoleValue(profile, group.roles, "fontFamily", firstRole.fontFamily || "Calibri")}
                  onChange={(value) => updateRoleGroup(group.roles, "fontFamily", value)}
                >
                  {SUPPORTED_CIM_STYLE_FONTS.map((font) => <option key={font} value={font}>{font}</option>)}
                </SelectInput>
              </label>
              <label>
                <ControlLabel>Size</ControlLabel>
                <SelectInput
                  value={getTextStyleSizePreset(profile, group.roles)}
                  onChange={(value) => updateTextStyleSizePreset(group.roles, value)}
                >
                  <option value="compact">Compact</option>
                  <option value="standard">Standard</option>
                  <option value="large">Large</option>
                </SelectInput>
              </label>
              <label>
                <ControlLabel>Weight</ControlLabel>
                <SelectInput
                  value={getSharedRoleValue(profile, group.roles, "weight", firstRole.weight || 400)}
                  onChange={(value) => updateRoleGroup(group.roles, "weight", value)}
                >
                  <option value={400}>Regular</option>
                  <option value={600}>Medium</option>
                  <option value={700}>Bold</option>
                  <option value={800}>Heavy</option>
                </SelectInput>
              </label>
              <label>
                <ControlLabel>Alignment</ControlLabel>
                <SelectInput
                  value={getSharedRoleValue(profile, group.roles, "alignment", firstRole.alignment || "inherit")}
                  onChange={(value) => updateRoleGroup(group.roles, "alignment", value)}
                >
                  <option value="inherit">Template</option>
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </SelectInput>
              </label>
            </div>
          </div>
        );
      })}

      <div className="rounded-md border border-border bg-white p-3">
        <div className="grid gap-3 md:grid-cols-3">
          <label>
            <ControlLabel>Capitalization</ControlLabel>
            <SelectInput value={profile.typography.roles.title.capitalization} onChange={(value) => {
              ["title", "heading", "subheading"].forEach((roleKey) => updateProfile(["typography", "roles", roleKey, "capitalization"], value));
            }}>
              <option value="none">Template</option>
              <option value="uppercase">Uppercase</option>
              <option value="title">Title Case</option>
            </SelectInput>
          </label>
          <label>
            <ControlLabel>Bullets</ControlLabel>
            <SelectInput value={profile.typography.bulletStyle} onChange={(value) => updateProfile(["typography", "bulletStyle"], value)}>
              <option value="standard">Standard</option>
              <option value="dash">Dash</option>
              <option value="none">None</option>
            </SelectInput>
          </label>
          <label>
            <ControlLabel>Numbering</ControlLabel>
            <SelectInput value={profile.typography.numberingStyle} onChange={(value) => updateProfile(["typography", "numberingStyle"], value)}>
              <option value="decimal">1, 2, 3</option>
              <option value="roman">I, II, III</option>
              <option value="alpha">A, B, C</option>
            </SelectInput>
          </label>
        </div>
      </div>
    </div>
  );
}

function BackgroundTab({ profile, updateProfile, reportError, colorPickerProps }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <label>
          <ControlLabel>Mode</ControlLabel>
          <SelectInput value={profile.background.mode} onChange={(value) => updateProfile(["background", "mode"], value)}>
            <option value="template">Template</option>
            <option value="solid">Solid</option>
            <option value="gradient">Gradient</option>
            <option value="image">Image</option>
          </SelectInput>
        </label>
        <label>
          <ControlLabel>Apply To</ControlLabel>
          <SelectInput value={profile.background.applyTo} onChange={(value) => updateProfile(["background", "applyTo"], value)}>
            <option value="all">All slides</option>
            <option value="cover">Cover only</option>
            <option value="section">Section slides</option>
          </SelectInput>
        </label>
        <label>
          <ControlLabel>Transition</ControlLabel>
          <SelectInput value={profile.transition} onChange={(value) => updateProfile(["transition"], value)}>
            {CIM_STYLE_TRANSITION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </SelectInput>
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <ColorInput label="Solid Color" value={profile.background.color} onChange={(value) => updateProfile(["background", "color"], value)} {...colorPickerProps} />
        <ColorInput label="Gradient From" value={profile.background.gradientFrom} onChange={(value) => updateProfile(["background", "gradientFrom"], value)} {...colorPickerProps} />
        <ColorInput label="Gradient To" value={profile.background.gradientTo} onChange={(value) => updateProfile(["background", "gradientTo"], value)} {...colorPickerProps} />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <label>
          <ControlLabel>Gradient Angle</ControlLabel>
          <NumberInput value={profile.background.gradientAngle} min={0} max={359} onChange={(value) => updateProfile(["background", "gradientAngle"], value)} />
        </label>
        <label>
          <ControlLabel>Image Opacity</ControlLabel>
          <NumberInput value={profile.background.imageOpacity} min={0.08} max={1} step={0.02} onChange={(value) => updateProfile(["background", "imageOpacity"], value)} />
        </label>
        <ImageUploadControl
          label="Background Image"
          image={profile.background.image}
          onChange={(value) => updateProfile(["background", "image"], value)}
          onError={reportError}
        />
      </div>
    </div>
  );
}

function TablesTab({ profile, updateProfile, colorPickerProps }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <ColorInput label="Header" value={profile.tables.headerColor} onChange={(value) => updateProfile(["tables", "headerColor"], value)} {...colorPickerProps} />
        <ColorInput label="Header Text" value={profile.tables.headerTextColor} onChange={(value) => updateProfile(["tables", "headerTextColor"], value)} {...colorPickerProps} />
        <ColorInput label="Border" value={profile.tables.borderColor} onChange={(value) => updateProfile(["tables", "borderColor"], value)} {...colorPickerProps} />
        <ColorInput label="Row" value={profile.tables.rowColor} onChange={(value) => updateProfile(["tables", "rowColor"], value)} {...colorPickerProps} />
        <ColorInput label="Alternate Row" value={profile.tables.altRowColor} onChange={(value) => updateProfile(["tables", "altRowColor"], value)} {...colorPickerProps} />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <label>
          <ControlLabel>Border Width</ControlLabel>
          <NumberInput value={profile.tables.borderWidth} min={0} max={4} step={0.1} onChange={(value) => updateProfile(["tables", "borderWidth"], value)} />
        </label>
        <label>
          <ControlLabel>Cell Padding</ControlLabel>
          <NumberInput value={profile.tables.cellPadding} min={0} max={24} onChange={(value) => updateProfile(["tables", "cellPadding"], value)} />
        </label>
        <div>
          <ControlLabel>Rows</ControlLabel>
          <ToggleInput checked={profile.tables.alternateRows} onChange={(value) => updateProfile(["tables", "alternateRows"], value)} label="Alternate row colors" />
        </div>
      </div>
    </div>
  );
}

function ChartsTab({ profile, updateProfile, colorPickerProps }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        {profile.charts.palette.map((color, index) => (
          <ColorInput
            key={index}
            label={`Palette ${index + 1}`}
            value={color}
            onChange={(value) => {
              const next = [...profile.charts.palette];
              next[index] = value;
              updateProfile(["charts", "palette"], next);
            }}
            {...colorPickerProps}
          />
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <ColorInput label="Chart Background" value={profile.charts.backgroundColor} onChange={(value) => updateProfile(["charts", "backgroundColor"], value)} {...colorPickerProps} />
        <ColorInput label="Grid" value={profile.charts.gridColor} onChange={(value) => updateProfile(["charts", "gridColor"], value)} {...colorPickerProps} />
        <ColorInput label="Labels" value={profile.charts.labelColor} onChange={(value) => updateProfile(["charts", "labelColor"], value)} {...colorPickerProps} />
        <ColorInput label="Title" value={profile.charts.titleColor} onChange={(value) => updateProfile(["charts", "titleColor"], value)} {...colorPickerProps} />
        <label>
          <ControlLabel>Legend</ControlLabel>
          <SelectInput value={profile.charts.legendPosition} onChange={(value) => updateProfile(["charts", "legendPosition"], value)}>
            <option value="right">Right</option>
            <option value="bottom">Bottom</option>
            <option value="none">None</option>
          </SelectInput>
        </label>
        <label>
          <ControlLabel>Axis Font</ControlLabel>
          <SelectInput value={profile.charts.axisFontFamily} onChange={(value) => updateProfile(["charts", "axisFontFamily"], value)}>
            {SUPPORTED_CIM_STYLE_FONTS.map((font) => <option key={font} value={font}>{font}</option>)}
          </SelectInput>
        </label>
      </div>
    </div>
  );
}

function BrandingTab({ profile, updateProfile, reportError, colorPickerProps }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <label>
          <ControlLabel>Page Numbers</ControlLabel>
          <ToggleInput checked={profile.footer.pageNumbers} onChange={(value) => updateProfile(["footer", "pageNumbers"], value)} label="Visible" />
        </label>
        <label>
          <ControlLabel>Footer Position</ControlLabel>
          <SelectInput value={profile.footer.labelPosition} onChange={(value) => updateProfile(["footer", "labelPosition"], value)}>
            <option value="bottom-left">Bottom left</option>
            <option value="bottom-center">Bottom center</option>
            <option value="bottom-right">Bottom right</option>
          </SelectInput>
        </label>
        <ColorInput label="Footer Color" value={profile.footer.color} onChange={(value) => updateProfile(["footer", "color"], value)} {...colorPickerProps} />
      </div>
      <label className="block">
        <ControlLabel>Confidentiality Label</ControlLabel>
        <input
          value={profile.footer.confidentialityLabel}
          maxLength={120}
          onChange={(event) => updateProfile(["footer", "confidentialityLabel"], event.target.value)}
          className="h-10 w-full rounded-md border border-border bg-white px-3 text-sm text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
        />
      </label>
      <div className="grid gap-3 md:grid-cols-4">
        <div>
          <ControlLabel>Watermark</ControlLabel>
          <ToggleInput checked={profile.watermark.visible} onChange={(value) => updateProfile(["watermark", "visible"], value)} label="Visible" />
        </div>
        <label>
          <ControlLabel>Position</ControlLabel>
          <SelectInput value={profile.watermark.position} onChange={(value) => updateProfile(["watermark", "position"], value)}>
            <option value="center">Center</option>
            <option value="top-right">Top right</option>
            <option value="bottom-right">Bottom right</option>
          </SelectInput>
        </label>
        <label>
          <ControlLabel>Opacity</ControlLabel>
          <NumberInput value={profile.watermark.opacity} min={0.04} max={0.6} step={0.01} onChange={(value) => updateProfile(["watermark", "opacity"], value)} />
        </label>
        <label>
          <ControlLabel>Width</ControlLabel>
          <NumberInput value={profile.watermark.width} min={120} max={760} onChange={(value) => updateProfile(["watermark", "width"], value)} />
        </label>
      </div>
      <ImageUploadControl
        label="Watermark Image"
        image={profile.watermark.image}
        onChange={(value) => updateProfile(["watermark", "image"], value)}
        onError={reportError}
      />
      <div className="grid gap-3 md:grid-cols-4">
        <label>
          <ControlLabel>Image Radius</ControlLabel>
          <NumberInput value={profile.images.cornerRadius} min={0} max={36} onChange={(value) => updateProfile(["images", "cornerRadius"], value)} />
        </label>
        <label>
          <ControlLabel>Image Border</ControlLabel>
          <NumberInput value={profile.images.borderWidth} min={0} max={8} step={0.5} onChange={(value) => updateProfile(["images", "borderWidth"], value)} />
        </label>
        <ColorInput
          label="Border Color"
          value={profile.images.borderColor}
          onChange={(value) => updateProfile(["images", "borderColor"], value)}
          opacity={profile.images.opacity}
          onOpacityChange={(value) => updateProfile(["images", "opacity"], value)}
          opacityLabel="Image opacity"
          {...colorPickerProps}
        />
      </div>
    </div>
  );
}

export default function CimTemplateStyleEditor({
  open,
  profilesState,
  previewSlides = DEFAULT_PREVIEW_SLIDES,
  sections = [],
  saving = false,
  onClose,
  onSave,
  renderPreview,
}) {
  const initialProfilesState = normalizeCimStyleProfilesState(profilesState);
  const [draftState, setDraftState] = useState(() => initialProfilesState);
  const [selectedProfileId, setSelectedProfileId] = useState(
    () => initialProfilesState.activeProfileId || DEFAULT_CIM_STYLE_PROFILE_ID,
  );
  const [activeTab, setActiveTab] = useState("colors");
  const [previewSlide, setPreviewSlide] = useState(1);
  const [recentColors, setRecentColors] = useState([]);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState([]);

  const selectedProfile = useMemo(() => {
    return draftState.profiles.find((profile) => profile.id === selectedProfileId) || draftState.profiles[0];
  }, [draftState.profiles, selectedProfileId]);

  const normalizedSelected = useMemo(
    () => normalizeCimStyleProfile(selectedProfile),
    [selectedProfile],
  );

  const slideNumbers = useMemo(() => {
    const values = Array.isArray(previewSlides) && previewSlides.length ? previewSlides : DEFAULT_PREVIEW_SLIDES;
    return values.map(Number).filter((slideNumber) => Number.isFinite(slideNumber) && slideNumber > 0);
  }, [previewSlides]);

  const groupedSlides = useMemo(() => {
    const seen = new Set();
    const groups = [];
    (sections || []).forEach((section) => {
      const slides = (section.slides || []).map(Number).filter((slideNumber) => slideNumbers.includes(slideNumber));
      if (!slides.length) return;
      slides.forEach((slideNumber) => seen.add(slideNumber));
      groups.push({
        id: section.id || section.title || `section-${groups.length + 1}`,
        title: section.title || "Section",
        number: section.number || "",
        slides,
      });
    });
    const remaining = slideNumbers.filter((slideNumber) => !seen.has(slideNumber));
    if (remaining.length) groups.push({ id: "other-slides", title: "Other Slides", number: "", slides: remaining });
    return groups;
  }, [sections, slideNumbers]);

  const presetColors = useMemo(() => {
    return Array.from(new Set([
      ...Object.values(DEFAULT_CIM_STYLE_COLORS),
      ...Object.values(normalizedSelected.colors || {}),
      ...(normalizedSelected.charts?.palette || []),
      ...DEFAULT_COLOR_PRESETS,
    ].map((color) => normalizePickerHex(color, "")).filter(Boolean))).slice(0, 18);
  }, [normalizedSelected]);

  const rememberColor = (color) => {
    const normalized = normalizePickerHex(color, "");
    if (!normalized) return;
    setRecentColors((previous) => [
      normalized,
      ...previous.filter((item) => item !== normalized),
    ].slice(0, 10));
  };

  const colorPickerProps = {
    presetColors,
    recentColors,
    onColorPicked: rememberColor,
  };

  if (!open) return null;

  const updateProfile = (path, value) => {
    if (normalizedSelected.locked) return;
    setDraftState((previous) => ({
      ...previous,
      profiles: previous.profiles.map((profile) => (
        profile.id === normalizedSelected.id
          ? normalizeCimStyleProfile(updateNested(profile, path, value))
          : profile
      )),
      activeProfileId: normalizedSelected.id,
      updatedAt: new Date().toISOString(),
    }));
  };

  const replaceProfile = (profile) => {
    const normalized = normalizeCimStyleProfile(profile);
    setDraftState((previous) => ({
      ...previous,
      activeProfileId: normalized.id,
      profiles: previous.profiles.map((item) => item.id === normalized.id ? normalized : item),
      updatedAt: new Date().toISOString(),
    }));
  };

  const createProfile = () => {
    const profile = createCimStyleProfile({ name: "New Brand Style" });
    setDraftState((previous) => ({
      ...previous,
      activeProfileId: profile.id,
      profiles: [...previous.profiles, profile],
      updatedAt: new Date().toISOString(),
    }));
    setSelectedProfileId(profile.id);
  };

  const duplicateProfile = () => {
    const profile = createCimStyleProfile({
      ...normalizedSelected,
      id: undefined,
      locked: false,
      isDefault: false,
      name: `${normalizedSelected.name.replace(/\s+Copy$/i, "")} Copy`,
    });
    setDraftState((previous) => ({
      ...previous,
      activeProfileId: profile.id,
      profiles: [...previous.profiles, profile],
      updatedAt: new Date().toISOString(),
    }));
    setSelectedProfileId(profile.id);
  };

  const deleteProfile = () => {
    if (normalizedSelected.locked) return;
    if (!window.confirm(`Delete ${normalizedSelected.name}?`)) return;
    setDraftState((previous) => {
      const profiles = previous.profiles.filter((profile) => profile.id !== normalizedSelected.id);
      return {
        ...previous,
        activeProfileId: DEFAULT_CIM_STYLE_PROFILE_ID,
        profiles,
        updatedAt: new Date().toISOString(),
      };
    });
    setSelectedProfileId(DEFAULT_CIM_STYLE_PROFILE_ID);
  };

  const resetToDefault = () => {
    setDraftState((previous) => ({
      ...previous,
      activeProfileId: DEFAULT_CIM_STYLE_PROFILE_ID,
      updatedAt: new Date().toISOString(),
    }));
    setSelectedProfileId(DEFAULT_CIM_STYLE_PROFILE_ID);
  };

  const importProfile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const { profile, warnings: importWarnings } = importCimStyleProfileJson(text);
      const imported = createCimStyleProfile({
        ...profile,
        id: undefined,
        name: profile.name ? `${profile.name} Imported` : "Imported Style",
      });
      setDraftState((previous) => ({
        ...previous,
        activeProfileId: imported.id,
        profiles: [...previous.profiles, imported],
        updatedAt: new Date().toISOString(),
      }));
      setSelectedProfileId(imported.id);
      setWarnings(importWarnings);
      setError("");
    } catch {
      setError("The selected style profile could not be imported.");
    }
  };

  const exportProfile = () => {
    downloadText(`${slugify(normalizedSelected.name)}.json`, exportCimStyleProfileJson(normalizedSelected));
  };

  const handleSave = async () => {
    const validation = validateCimStyleProfile(normalizedSelected);
    const normalizedProfiles = draftState.profiles.map((profile) => (
      profile.id === normalizedSelected.id ? validation.profile : normalizeCimStyleProfile(profile)
    ));
    const nextState = normalizeCimStyleProfilesState({
      ...draftState,
      activeProfileId: normalizedSelected.id,
      profiles: normalizedProfiles,
      updatedAt: new Date().toISOString(),
    });
    setWarnings(validation.warnings);
    setError("");
    try {
      await onSave(nextState);
    } catch (saveError) {
      setError(saveError?.message || "Template style profile could not be saved.");
    }
  };

  const renderActiveTab = () => {
    if (activeTab === "colors") return <ColorsTab profile={normalizedSelected} updateProfile={updateProfile} colorPickerProps={colorPickerProps} />;
    if (activeTab === "fonts") return <FontsTab profile={normalizedSelected} updateProfile={updateProfile} />;
    if (activeTab === "background") return <BackgroundTab profile={normalizedSelected} updateProfile={updateProfile} reportError={setError} colorPickerProps={colorPickerProps} />;
    if (activeTab === "tables") return <TablesTab profile={normalizedSelected} updateProfile={updateProfile} colorPickerProps={colorPickerProps} />;
    if (activeTab === "charts") return <ChartsTab profile={normalizedSelected} updateProfile={updateProfile} colorPickerProps={colorPickerProps} />;
    return <BrandingTab profile={normalizedSelected} updateProfile={updateProfile} reportError={setError} colorPickerProps={colorPickerProps} />;
  };

  return (
    <div className="fixed inset-0 z-[99999] bg-[#111827]/70 p-3 text-[#050505] backdrop-blur-sm lg:p-5">
      <div className="mx-auto grid h-full max-w-[1560px] overflow-hidden rounded-lg bg-white shadow-2xl lg:grid-cols-[240px_minmax(0,1fr)]">
        <ProfileList
          state={draftState}
          selectedProfileId={selectedProfileId}
          onSelect={(profileId) => {
            setSelectedProfileId(profileId);
            setDraftState((previous) => ({ ...previous, activeProfileId: profileId }));
          }}
          onCreate={createProfile}
          onDuplicate={duplicateProfile}
          onDelete={deleteProfile}
          onReset={resetToDefault}
          onImport={importProfile}
          onExport={exportProfile}
        />

        <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#EEF6E0] text-[#476E2C]">
                <Palette size={18} />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-base font-bold text-[#050505]">Customize Template</h2>
                <p className="text-xs font-semibold text-[#6D6E71]">{normalizedSelected.locked ? "Default template" : "Style profile"}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-white text-[#6D6E71] transition hover:bg-[#F7F8FA] hover:text-[#050505]"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
          </header>

          <div className="grid min-h-0 lg:grid-cols-[minmax(0,1fr)_520px]">
            <div className="min-h-0 overflow-y-auto border-r border-border bg-[#F7F8FA] p-4">
              <div className="mb-4 rounded-lg border border-border bg-white p-3">
                <ControlLabel>Profile Name</ControlLabel>
                <input
                  value={normalizedSelected.name}
                  disabled={normalizedSelected.locked}
                  onChange={(event) => replaceProfile({ ...normalizedSelected, name: event.target.value })}
                  className="h-10 w-full rounded-md border border-border bg-white px-3 text-sm font-semibold text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20 disabled:bg-[#F7F8FA] disabled:text-[#8A8F98]"
                />
              </div>

              {normalizedSelected.locked ? (
                <div className="mb-4 rounded-lg border border-[#DDEBCB] bg-[#F8FCF3] p-3 text-xs font-semibold text-[#476E2C]">
                  Duplicate the default profile to edit broker branding.
                </div>
              ) : null}

              <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
                {EDITOR_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    className={`h-9 shrink-0 rounded-md border px-3 text-xs font-bold transition ${
                      activeTab === tab.key
                        ? "border-[#8BC53D] bg-[#EEF6E0] text-[#476E2C]"
                        : "border-border bg-white text-[#6D6E71] hover:border-[#BFD99B]"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <fieldset disabled={normalizedSelected.locked} className={normalizedSelected.locked ? "pointer-events-none opacity-55" : ""}>
                {renderActiveTab()}
              </fieldset>
            </div>

            <aside className="min-h-0 overflow-y-auto bg-white p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-xs font-bold uppercase tracking-[0.06em] text-[#6D6E71]">Live Preview</span>
                <span className="rounded-md bg-[#EEF6E0] px-2 py-1 text-[11px] font-bold text-[#476E2C]">
                  Slide {previewSlide}
                </span>
              </div>
              <div className="rounded-lg border border-border bg-[#F7F8FA] p-2">
                {renderPreview?.({ profile: normalizedSelected, slideNumber: previewSlide })}
              </div>
              <label className="mt-4 block rounded-md border border-border bg-white p-3">
                <ControlLabel>Preview Slide</ControlLabel>
                <SelectInput value={previewSlide} onChange={(value) => setPreviewSlide(Number(value))}>
                  {groupedSlides.map((group) => (
                    <optgroup key={group.id} label={`${group.number ? `${group.number} ` : ""}${group.title}`}>
                      {group.slides.map((slideNumber) => (
                        <option key={slideNumber} value={slideNumber}>Slide {slideNumber}</option>
                      ))}
                    </optgroup>
                  ))}
                </SelectInput>
              </label>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <div className="rounded-md border border-border bg-white p-2">
                  <span className="block text-[10px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">Primary</span>
                  <span className="mt-2 block h-8 rounded" style={{ backgroundColor: normalizedSelected.colors.primary }} />
                </div>
                <div className="rounded-md border border-border bg-white p-2">
                  <span className="block text-[10px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">Secondary</span>
                  <span className="mt-2 block h-8 rounded" style={{ backgroundColor: normalizedSelected.colors.secondary }} />
                </div>
                <div className="rounded-md border border-border bg-white p-2">
                  <span className="block text-[10px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">Accent</span>
                  <span className="mt-2 block h-8 rounded" style={{ backgroundColor: normalizedSelected.colors.accent }} />
                </div>
              </div>
            </aside>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-white px-4 py-3">
            <div className="min-w-0">
              {error ? <p className="text-xs font-bold text-red-600">{error}</p> : null}
              {warnings.length ? (
                <p className="text-xs font-semibold text-[#A86F0B]">{warnings[0]}{warnings.length > 1 ? ` +${warnings.length - 1}` : ""}</p>
              ) : (
                <p className="text-xs font-semibold text-[#6D6E71]">Version {normalizedSelected.version}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={resetToDefault}
                className="theme-btn-secondary"
              >
                <RefreshCcw size={16} />
                Reset
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="theme-btn-primary disabled:cursor-not-allowed disabled:opacity-70"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                Save Profile
              </button>
              <button
                type="button"
                onClick={onClose}
                className="theme-btn-secondary"
              >
                <Check size={16} />
                Done
              </button>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}
