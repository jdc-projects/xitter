'use client';

import { Alert, Button, Group, Modal, Text, Textarea, TextInput } from '@mantine/core';
import { useActionState, useState } from 'react';
import { updateProfileAction, type ActionResult } from './actions';

export interface EditProfileFormProps {
  userId: string;
  username: string;
  displayName: string;
  bio: string | null;
}

/**
 * Own-profile editor: displayName and bio only (spec 8.2). The PII reminder
 * sits directly under the bio field (content guidelines: adjacent to every
 * text input, unmissable).
 */
export function EditProfileForm({ userId, username, displayName, bio }: EditProfileFormProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    updateProfileAction,
    undefined,
  );

  return (
    <>
      <Button size="xs" variant="light" onClick={() => setOpen(true)} data-testid="edit-profile-button">
        Edit profile
      </Button>
      <Modal
        opened={open}
        onClose={() => setOpen(false)}
        title="Edit profile"
        centered
        data-testid="edit-profile-modal"
      >
        <form action={formAction}>
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="username" value={username} />
          <TextInput
            name="displayName"
            label="Display name"
            defaultValue={displayName}
            maxLength={50}
            required
            data-testid="edit-display-name"
          />
          <Textarea
            name="bio"
            label="Bio"
            description="Up to 200 characters."
            defaultValue={bio ?? ''}
            maxLength={200}
            autosize
            minRows={2}
            mt="md"
            data-testid="edit-bio"
          />
          <Text size="xs" c="orange.7" mt="xs" data-testid="bio-pii-reminder">
            Demo site: do not enter personal or sensitive data. Anyone can read it and nothing is
            retained - everything is wiped nightly.
          </Text>
          {state?.error ? (
            <Alert color="red" mt="sm" data-testid="edit-profile-error">
              {state.error}
            </Alert>
          ) : null}
          <Group justify="flex-end" mt="lg">
            <Button variant="subtle" onClick={() => setOpen(false)} size="xs">
              Cancel
            </Button>
            <Button type="submit" loading={pending} size="xs" data-testid="save-profile-button">
              Save
            </Button>
          </Group>
        </form>
      </Modal>
    </>
  );
}
