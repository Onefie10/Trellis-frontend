import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReleaseNotesEditor } from '../components/ReleaseNotesEditor';
import { parseCommitMessage } from '../lib/changelog-parser';

const repository = 'TRELLIS-STELLAR/Trellis-frontend';
const commits = [
  parseCommitMessage('feat(versioning): add changelog generator (#120)', '1111111'),
  parseCommitMessage('fix: correct preview crash (#121)', '2222222'),
];

describe('ReleaseNotesEditor', () => {
  it('prefills the draft with generated release notes and a live preview', () => {
    render(
      <ReleaseNotesEditor commits={commits} version="1.2.0" repository={repository} />,
    );

    const textarea = screen.getByLabelText('Release notes markdown') as HTMLTextAreaElement;

    expect(textarea.value).toContain('# Release notes: v1.2.0');
    expect(textarea.value).toContain('## Features');
    expect(textarea.value).toContain('## Bug Fixes');
    expect(screen.getByTestId('release-notes-preview')).toHaveTextContent('Features');
    expect(screen.getByTestId('release-notes-preview')).toHaveTextContent('Bug Fixes');
  });

  it('lets authors customise the draft and reports changes', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();

    render(<ReleaseNotesEditor commits={commits} version="1.2.0" onChange={onChange} />);

    const textarea = screen.getByLabelText('Release notes markdown');
    await user.clear(textarea);
    await user.type(textarea, '## Handwritten notes');

    expect(onChange).toHaveBeenLastCalledWith('## Handwritten notes');
    expect(screen.getByTestId('release-notes-preview')).toHaveTextContent('Handwritten notes');
  });

  it('regenerates the draft from commits on demand', async () => {
    const user = userEvent.setup();

    render(<ReleaseNotesEditor commits={commits} version="1.2.0" />);

    const textarea = screen.getByLabelText('Release notes markdown') as HTMLTextAreaElement;
    await user.clear(textarea);
    await user.type(textarea, 'custom');
    await user.click(screen.getByRole('button', { name: /regenerate from commits/i }));

    expect(textarea.value).toContain('# Release notes: v1.2.0');
  });
});
