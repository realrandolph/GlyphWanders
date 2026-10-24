import {reddit} from '@devvit/web/server'
import type {T1, T3} from '@devvit/web/shared'
import type {RedditApi} from './executor.ts'

/** Adapts the supported Devvit Reddit client to the executor's narrow API. */
export const redditApi: RedditApi = {
  getPostById: id => reddit.getPostById(id as T3),
  getCommentById: id => reddit.getCommentById(id as T1),
  getNewPosts: options => reddit.getNewPosts(options),
  getComments: options =>
    reddit.getComments({
      ...options,
      postId: options.postId as T3,
      commentId: options.commentId as T1 | undefined,
    }),
  submitPost: options =>
    reddit.submitPost({
      subredditName: options.subredditName,
      title: options.title,
      text: options.text,
      runAs: 'APP',
    }),
  submitComment: options =>
    reddit.submitComment({
      id: options.id as T1 | T3,
      text: options.text,
      runAs: 'APP',
    }),
}
