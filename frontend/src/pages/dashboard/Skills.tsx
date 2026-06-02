import { useEffect, useState } from 'react'
import { PageHeader, PageScaffold, SectionCard } from '../../components/dashboard/PageScaffold'
import { Icons } from '../../components/icons'
import { api, errorMessage } from '../../lib/api'
import { useMe, userCard } from './useMe'
import { useToast } from '../../components/Toast'

interface SkillTrigger {
  sample: string
}

interface SkillInfo {
  name: string
  display_name: string
  description: string
  triggers: SkillTrigger[]
}

/**
 * Skills dashboard — Settings → Research → Skills.
 *
 * Lists the proprietary domain expertise the chat router can activate
 * for the current workspace. Skills aren't user-installable today (the
 * brief content is server-side); this page surfaces what exists +
 * what triggers each one so users know the agent reaches for them
 * automatically.
 */
export function SkillsPage() {
  const { me } = useMe()
  const toast = useToast()
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<SkillInfo[]>('/skills', { auth: true })
        const sorted = [...r].sort((a, b) =>
          a.display_name.localeCompare(b.display_name),
        )
        setSkills(sorted)
      } catch (err) {
        toast.error(errorMessage(err, "Couldn't load skills."))
        setSkills([])
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <PageScaffold
      active="skills"
      crumbs={['Settings', 'Research', 'Skills']}
      user={userCard(me)}
    >
      <PageHeader
        eyebrow="RESEARCH"
        title="Skills"
        desc="Domain expertise the agent activates automatically. Skills run server-side — each ships a tight brief that's injected as a system message when a matching prompt arrives. Authoring custom skills will land in a later release."
      />
      <SectionCard
        title="Registered skills"
        desc="Whenever your message matches a trigger phrase, the matching skill's brief is added to the agent's context before it answers."
      >
        {skills === null ? (
          <div
            style={{ padding: '16px 18px', fontSize: 12.5, color: 'var(--color-muted)' }}
          >
            Loading…
          </div>
        ) : skills.length === 0 ? (
          <div
            style={{
              padding: '16px 18px',
              fontSize: 13,
              color: 'var(--color-ink-2)',
              lineHeight: 1.55,
            }}
          >
            No skills registered. Reach out if you'd like one for your domain.
          </div>
        ) : (
          <ul
            aria-label="Registered skills"
            style={{
              listStyle: 'none',
              margin: 0,
              padding: '6px 8px 10px',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
              gap: 12,
            }}
          >
            {skills.map((s) => (
              <li
                key={s.name}
                style={{
                  background: '#fff',
                  border: '1px solid var(--color-rule)',
                  borderRadius: 12,
                  padding: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      background: 'color-mix(in oklch, var(--color-indigo) 14%, transparent)',
                      color: 'var(--color-indigo)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Icons.sparkles size={13} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: 'var(--color-ink)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {s.display_name}
                    </div>
                    <div
                      className="font-mono"
                      style={{
                        fontSize: 10.5,
                        color: 'var(--color-muted)',
                        letterSpacing: '0.04em',
                      }}
                    >
                      {s.name}
                    </div>
                  </div>
                  <span className="tag teal" style={{ fontSize: 10 }}>
                    auto
                  </span>
                </div>
                <p
                  style={{
                    fontSize: 13,
                    color: 'var(--color-ink-2)',
                    lineHeight: 1.55,
                    margin: 0,
                  }}
                >
                  {s.description}
                </p>
                {s.triggers.length > 0 && (
                  <div
                    style={{
                      borderTop: '1px solid var(--color-rule)',
                      paddingTop: 8,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div
                      className="font-mono"
                      style={{
                        fontSize: 10,
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        color: 'var(--color-muted)',
                      }}
                    >
                      Activates on phrases like
                    </div>
                    {s.triggers.slice(0, 3).map((t, i) => (
                      <code
                        key={i}
                        className="font-mono"
                        style={{
                          fontSize: 11.5,
                          background: 'var(--color-paper-2)',
                          padding: '3px 6px',
                          borderRadius: 4,
                          color: 'var(--color-ink-2)',
                          lineHeight: 1.4,
                          wordBreak: 'break-word',
                        }}
                      >
                        {t.sample}
                      </code>
                    ))}
                    {s.triggers.length > 3 && (
                      <span
                        style={{
                          fontSize: 11,
                          color: 'var(--color-muted)',
                        }}
                      >
                        + {s.triggers.length - 3} more
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard
        title="How skills work"
        desc="Compressed briefs the agent loads on demand — never visible in the chat output."
      >
        <div
          style={{
            padding: '14px 18px',
            fontSize: 13,
            color: 'var(--color-ink-2)',
            lineHeight: 1.6,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <p style={{ margin: 0 }}>
            Skills are notesci's way of giving the chat agent narrow,
            high-signal expertise. Each skill ships a ~400-token brief
            distilled from a longer playbook, so the agent's behavior
            shifts the moment your prompt matches the trigger — without
            burning your model's context window on a giant system
            prompt.
          </p>
          <p style={{ margin: 0 }}>
            Multiple skills can activate at once (e.g. "draft an
            abstract and polish it" fires the scientific drafting +
            writing-clearly skills together). The full SKILL.md sources
            live at <code className="font-mono">.claude/skills/</code>{' '}
            in the repo for reference.
          </p>
        </div>
      </SectionCard>
    </PageScaffold>
  )
}
