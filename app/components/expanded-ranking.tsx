import type { CultureSection } from "../lib/culture";

export function ExpandedRanking({ section }: { section: CultureSection }) {
  if (!section.moreItems?.length) return null;

  const firstRank = section.moreItems[0].rank;
  const lastRank = section.moreItems.at(-1)?.rank ?? firstRank;
  const label = section.moreLabel ?? `Show ranks ${firstRank}–${lastRank}`;

  return (
    <details className="expanded-ranking">
      <summary>
        <span>{label}</span>
        <span className="expand-symbol" aria-hidden="true">+</span>
      </summary>
      <ol start={firstRank}>
        {section.moreItems.map((item) => (
          <li key={item.title} value={item.rank}>
            <a href={item.url} target="_blank" rel="noopener noreferrer">
              <span className="expanded-rank" aria-hidden="true">{item.rank}</span>
              <span className="expanded-name">
                <strong>{item.title}</strong>
                <small>{item.subtitle}</small>
              </span>
              {item.metric ? (
                <span className="expanded-metric">
                  <small>{item.metric.label}</small>
                  <strong>{item.metric.value}</strong>
                </span>
              ) : null}
              <span className="expanded-link" aria-hidden="true">↗</span>
            </a>
          </li>
        ))}
      </ol>
    </details>
  );
}
