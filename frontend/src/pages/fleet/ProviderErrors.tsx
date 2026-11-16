// One banner for every monitoring platform that couldn't be reached, instead
// of a full-width banner per platform (four outages used to push the page
// content below the fold on tablets and phones).
import { Icon } from '../../ui';

export function ProviderErrors({ errors, onCheck }: { errors: { provider: string; name: string }[]; onCheck?: () => void }) {
  if (!errors.length) return null;
  const names = errors.map((e) => e.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const text = (
    <span>
      <b>{list}</b> {names.length === 1 ? 'couldn’t be reached, so its' : `couldn’t be reached, so their`} plants may be missing or stale.
    </span>
  );
  return onCheck ? (
    <button type="button" className="c-banner t-warning fo-banner" onClick={onCheck}>
      <Icon name="alert" size={16} />
      {text}
      <span className="fo-banner-go">Check connections <Icon name="chevron" size={14} /></span>
    </button>
  ) : (
    <div className="c-banner t-warning" role="status"><Icon name="alert" size={16} />{text}</div>
  );
}
