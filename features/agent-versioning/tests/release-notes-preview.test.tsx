import { fireEvent, render, screen } from '@testing-library/react';
import { ReleaseNotesPreview } from '../components/ReleaseNotesPreview';
import { ParsedCommit, ReleaseNotesOptions } from '../types';

const commits: ParsedCommit[] = [
  {
    hash: 'abc1234',
    type: 'feat',
    scope: 'agent-versioning',
    subject: 'generate release notes from commit history',
    breaking: false,
    category: 'features',
    references: [{ number: 125, type: 'pull' }],
    body: '',
    raw: 'abc1234 feat(agent-versioning): generate release notes from commit history (#125)',
  },
  {
    hash: 'def5678',
    type: 'fix',
    subject: 'guard empty commit ranges',
    breaking: false,
    category: 'fixes',
    references: [{ number: 126, type: 'pull' }],
    body: '',
    raw: 'def5678 fix: guard empty commit ranges (#126)',
  },
];

const options: ReleaseNotesOptions = {
  version: '1.2.0',
  repository: 'TRELLIS-STELLAR/Trellis-frontend',
  date: '2026-09-27',
};

describe('ReleaseNotesPreview', () => {
  it('seeds the editable Markdown and the preview from commit history', () => {
    render(<ReleaseNotesPreview commits={commits} options={options} />);

    const textarea = screen.getByLabelText('Markdown (editable)') as HTMLTextAreaElement;

    expect(textarea.value).toContain('# Release v1.2.0');
    expect(textarea.value).toContain('## Features');
    expect(textarea.value).toContain(
      '[#125](https://github.com/TRELLIS-STELLAR/Trellis-frontend/pull/125)',
    );
    expect(textarea.value).toContain('## Bug Fixes');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Release v1.2.0' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Features' }),
    ).toBeInTheDocument();
  });

  it('reports the generated draft through onChange', () => {
    const onChange = jest.fn();

    render(<ReleaseNotesPreview commits={commits} options={options} onChange={onChange} />);

    expect(onChange).toHaveBeenCalledWith(expect.stringContaining('# Release v1.2.0'));
  });

  it('lets authors edit the changelog and updates the preview', () => {
    const onChange = jest.fn();

    render(<ReleaseNotesPreview commits={commits} options={options} onChange={onChange} />);

    const textarea = screen.getByLabelText('Markdown (editable)') as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: '# Custom Release\n\nHand written notes.' },
    });

    expect(textarea.value).toBe('# Custom Release\n\nHand written notes.');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Custom Release' }),
    ).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith('# Custom Release\n\nHand written notes.');
  });

  it('regenerates the draft from commits on demand', () => {
    render(<ReleaseNotesPreview commits={commits} options={options} />);

    const textarea = screen.getByLabelText('Markdown (editable)') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'manually edited notes' } });
    expect(textarea.value).toBe('manually edited notes');

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate from commits' }));

    expect(textarea.value).toContain('# Release v1.2.0');
    expect(textarea.value).toContain('## Features');
  });

  it('renders a controlled value without regenerating over it', () => {
    render(
      <ReleaseNotesPreview
        commits={commits}
        options={options}
        value={'# Controlled\n\n- frozen note'}
      />,
    );

    const textarea = screen.getByLabelText('Markdown (editable)') as HTMLTextAreaElement;
    expect(textarea.value).toBe('# Controlled\n\n- frozen note');
    expect(screen.getByRole('heading', { level: 1, name: 'Controlled' })).toBeInTheDocument();
  });
});
