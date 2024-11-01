import { condition, step, log } from '@restackio/ai/workflow';
import { onEvent } from '@restackio/ai/event';
import * as githubFunctions from '@restackio/integrations-github/functions';
import { githubTaskQueue } from '@restackio/integrations-github/taskQueue';
import { openaiTaskQueue } from '@restackio/integrations-openai/taskQueue';
import * as openaiFunctions from '@restackio/integrations-openai/functions';

import * as functions from '../functions/index.js';

import {
  NextTagName,
  nextTagNameJsonSchema,
} from '../functions/schemas/tagNameSchema.js';

import {
  publishReleaseEvent,
  PublishReleaseEventInput,
} from '../events/publishRelease.js';

import {
  createReleaseEvent,
  CreateReleaseEventInput,
} from '../events/createRelease.js';

import { greetingEvent } from '../events/greetingEvent.js';
import { githubService } from '@restackio/integrations-github';

export async function handleReleaseWorkflow() {
  let endReleaseWorkflow = false;

  onEvent(
    publishReleaseEvent,
    async ({ id, owner, repo }: PublishReleaseEventInput) => {
      const release = await step<typeof githubFunctions>({
        taskQueue: githubTaskQueue,
      }).publishRelease({ owner, repo, id });

      return release;
    },
  );

  onEvent(greetingEvent, async () => {
    log.info('Greeting event received');
    const greetingMessage = await step<typeof functions>(
      {},
    ).vertexGenerateContent({
      systemContent:
        'You are a helpful assistant that will assis the user in creating github releases whenever a commit event is detected.',
      userContent:
        'Greet the user as this is the initial message. Let them know that whenever a new commit is detected you will ask them to confirm if they want to create a release based on the commits.',
    });

    return { assistantMessage: greetingMessage };
  });

  onEvent(
    createReleaseEvent,
    async ({ repository, branch, defaultBranch }: CreateReleaseEventInput) => {
      if (branch !== defaultBranch) {
        log.info(
          'No need to create release, push is not to default repository branch',
        );
        return;
      }

      const [owner, repo] = repository.split('/');
      let latestRelease;

      try {
        latestRelease = await step<typeof githubFunctions>({
          taskQueue: githubTaskQueue,
        }).getLatestRelease({
          owner,
          repo,
        });
      } catch (error) {
        log.warn('Latest release not found, this will be first release');
      }

      let tagName: string | null = '';

      if (!latestRelease) {
        tagName = 'v1.0.0';
      } else {
        const { result } = await step<typeof openaiFunctions>({
          taskQueue: openaiTaskQueue,
        }).openaiChatCompletionsBase({
          systemContent:
            'You are a helpful assistant that determines the next tag name for a github release. You will be given the current release tag name. You will need to return the next tag name. For now only suggest a minor version bump. If the tag provided has any prefix such as "v" your suggestion should also include the "v" prefix.',
          model: 'gpt-4o-mini',
          userContent: `
            Here is the current release tag name: ${latestRelease.tag_name}
          `,
          jsonSchema: nextTagNameJsonSchema,
        });
        const tagNameResult = result.choices[0].message.content;

        if (!tagNameResult) {
          tagName = 'v1.0.0';
        } else {
          const aiTagName = JSON.parse(tagNameResult) as NextTagName;
          tagName = aiTagName.tagName;
        }
      }

      const release = await step<typeof githubFunctions>({
        taskQueue: githubTaskQueue,
      }).createRelease({
        owner,
        repo,
        tagName,
        releaseName: `Release ${tagName}`,
        branch,
        isDraft: false,
      });

      log.info('Release created', { releaseUrl: release.html_url });

      return release;
    },
  );

  await condition(() => endReleaseWorkflow);
}