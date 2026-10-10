import {
  type ProblemAuthor,
  projectProblemAuthors,
} from "@tenkacloud/portal-contracts/problem-authors";

/** Text is rendered by React; never interpret names as markup or embed profiles. */
export function ProblemAuthors({
  authors,
  label,
}: {
  authors?: readonly ProblemAuthor[] | undefined;
  label: string;
}) {
  const publicAuthors = projectProblemAuthors(authors);
  if (!publicAuthors) return null;
  const occurrences = new Map<string, number>();
  const credits = publicAuthors.map((author) => {
    const identity = JSON.stringify(author);
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return { ...author, key: `${identity}:${occurrence}` };
  });
  return (
    <div style={{ overflowWrap: "anywhere" }}>
      <span>{label}: </span>
      {credits.map((author, index) => (
        <span key={author.key}>
          {index > 0 ? ", " : ""}
          {author.profileUrl ? (
            <a href={author.profileUrl} target="_blank" rel="noopener noreferrer">
              {author.name}
            </a>
          ) : (
            author.name
          )}
        </span>
      ))}
    </div>
  );
}
