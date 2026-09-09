import { publicImageOrders, type ShowOrder } from "@imageshow/shared/browser";
import { Icon, type IconName } from "../icon/Icon.js";

const defaultLabels: Record<ShowOrder, string> = { random: "乱序", latest: "最新", oldest: "最旧" };
const icons: Record<ShowOrder, IconName> = {
  random: "shuffle-line", latest: "sort-desc", oldest: "sort-asc"
};

export function PublicImageOrderButton({ order, onChange, labels = defaultLabels }: {
  order: ShowOrder;
  onChange: (order: ShowOrder) => void;
  labels?: Readonly<Record<ShowOrder, string>>;
}) {
  const next = publicImageOrders[(publicImageOrders.indexOf(order) + 1) % publicImageOrders.length]!;
  const label = `排列顺序：${labels[order]}；点击切换为${labels[next]}`;
  return (
    <button type="button" className="public-round-control pressable"
      aria-label={label} title={label} onClick={() => onChange(next)}>
      <span className="public-round-surface"><Icon name={icons[order]} /></span>
    </button>
  );
}
