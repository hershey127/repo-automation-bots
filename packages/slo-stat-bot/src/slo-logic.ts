// Copyright 2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {GitHubAPI} from 'probot/lib/github';
import moment from 'moment';

interface SLOStatus {
  appliesTo: boolean;
  isCompliant: boolean | null;
}

enum Priority {
  'P0',
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
}

interface SLORules {
  appliesTo: {
    gitHubLabels?: string | string[];
    excludedGitHubLabels?: string | string[];
    priority?: Priority;
    issueType?: string;
    issues?: boolean;
    prs?: boolean;
  };
  complianceSettings: {
    responseTime: string | number;
    resolutionTime: string | number;
    requiresAssignee?: boolean;
    responders?: {
      owners?: string | string[];
      contributors?: string;
      users?: string[];
    };
  };
}

interface IssueAssignees {
  login: string;
}

interface IssuesListCommentsItem {
  id: number;
  user: {
    login: string;
  };
  created_at: string;
  updated_at: string;
}

interface ReposListCollaboratorsItem {
  login: string;
  permissions: {
    pull: boolean;
    push: boolean;
    admin: boolean;
  };
}

//Checking if slo applies to a given issue
getSLOStatus.doesSloApply = async function doesSloApply(
  type: string,
  slo: SLORules,
  issueLabels: string[] | null
): Promise<boolean> {
  if (Object.keys(slo.appliesTo).length === 0) {
    return true;
  }

  if (issueLabels === null || issueLabels.length === 0) {
    return false;
  }

  //Checks if type is applicable depending if slo rule applies to prs or issues
  const appliesToIssues = slo.appliesTo.issues;
  const appliesToPrs = slo.appliesTo.prs;
  const isValidIssue = await getSLOStatus.isValidIssue(
    appliesToIssues,
    appliesToPrs,
    type
  );
  if (!isValidIssue) {
    return false;
  }

  //Checking if all the githublabels are subset of issue labels
  const githubLabels = slo.appliesTo.gitHubLabels;
  const isValidGithubLabels = await getSLOStatus.isValidGithubLabels(
    issueLabels,
    githubLabels
  );
  if (!isValidGithubLabels) {
    return false;
  }

  //Checking if all the excluded github labels are not in issue labels
  const excludedGitHubLabels = slo.appliesTo.excludedGitHubLabels;
  const isValidExcludeLabels = await getSLOStatus.isValidExcludedLabels(
    issueLabels,
    excludedGitHubLabels
  );
  if (!isValidExcludeLabels) {
    return false;
  }

  //Checking if priority is present and matches in issue labels
  const priority = String(slo.appliesTo.priority);
  const isValidPriority = await getSLOStatus.isValidRule(
    issueLabels,
    priority,
    'priority: '
  );
  if (!isValidPriority) {
    return false;
  }

  //Checking if issue type is present and matches in issue labels
  const issueType = slo.appliesTo.issueType;
  const isValidIssueType = await getSLOStatus.isValidRule(
    issueLabels,
    issueType,
    'type: '
  );
  if (!isValidIssueType) {
    return false;
  }

  return true;
};

getSLOStatus.isValidIssue = async function isValidIssue(
  issues: boolean | undefined,
  prs: boolean | undefined,
  type: string
): Promise<boolean> {
  issues = issues === undefined ? true : issues;
  prs = prs === undefined ? false : prs;

  if (type === 'pull_request' && prs) {
    return true;
  }
  if (type === 'issue' && issues) {
    return true;
  }
  return false;
};

getSLOStatus.isValidGithubLabels = async function isValidGithubLabels(
  issueLabels: string[],
  githubLabels: string | string[] | undefined
): Promise<boolean> {
  if (!githubLabels) {
    return true;
  }

  githubLabels = await getSLOStatus.convertToArray(githubLabels);
  githubLabels.forEach((label: string) => label.toLowerCase());
  const isSubSet = githubLabels.every((label: string) =>
    issueLabels.includes(label)
  );
  if (!isSubSet) {
    return false;
  }
  return true;
};

getSLOStatus.isValidExcludedLabels = async function isValidExcludedLabels(
  issueLabels: string[],
  excludedGitHubLabels: string | string[] | undefined
): Promise<boolean> {
  if (!excludedGitHubLabels) {
    return true;
  }

  excludedGitHubLabels = await getSLOStatus.convertToArray(
    excludedGitHubLabels
  );
  excludedGitHubLabels.forEach((label: string) => label.toLowerCase());
  const isElementExist = excludedGitHubLabels.some((label: string) =>
    issueLabels.includes(label)
  );
  if (isElementExist) {
    return false;
  }
  return true;
};

getSLOStatus.isValidRule = async function isValidRule(
  issueLabels: string[],
  rule: string | undefined,
  title: string
) {
  if (!rule) {
    return true;
  }

  rule = rule.toLowerCase();
  return issueLabels.includes(rule) || issueLabels.includes(title + rule);
};

getSLOStatus.convertToArray = async function convertToArray(
  variable: string[] | string
): Promise<string[]> {
  if (typeof variable === 'string') {
    return [variable];
  }
  return variable;
};

getSLOStatus.getFilePathContent = async function getFilePathContent(
  github: GitHubAPI,
  owner: string,
  repo: string,
  path: string
): Promise<string> {
  try {
    const fileResponse = await github.repos.getContents({
      owner,
      repo,
      path,
    });
    const data = fileResponse.data as {content?: string};
    const content = Buffer.from(data.content as string, 'base64').toString(
      'utf8'
    );
    return content;
  } catch (err) {
    return 'not found';
  }
};

//Checking if issue is compliant with slo
getSLOStatus.isCompliant = async function isCompliant(
  github: GitHubAPI,
  owner: string,
  repo: string,
  issueNumber: number,
  assignees: IssueAssignees[],
  issueUpdateTime: string,
  slo: SLORules
): Promise<boolean> {
  //Checking if issue is resolved within resolution time
  const resTime = slo.complianceSettings.resolutionTime;
  if (resTime !== 0) {
    const isInResTime = await getSLOStatus.isInDuration(
      resTime,
      issueUpdateTime
    );
    if (!isInResTime) {
      return false;
    }
  }

  const reqAssignee = slo.complianceSettings.requiresAssignee;
  const responseTime = slo.complianceSettings.responseTime;
  let responders: Set<string> = new Set();
  if (reqAssignee === true || responseTime !== 0) {
    responders = await getSLOStatus.getResponders(github, owner, repo, slo);
  }

  //Checking if issue is assigned if slo claims it must have assignee
  if (reqAssignee === true) {
    const isAssigned = await getSLOStatus.isAssigned(responders, assignees);
    if (!isAssigned) {
      return false;
    }
  }

  //Checking if issue is responded within response time
  if (responseTime !== 0) {
    const listIssueComments = await getSLOStatus.getIssueCommentsList(
      github,
      owner,
      repo,
      issueNumber
    );
    const isInResponseTime = await getSLOStatus.isInResponseTime(
      responders,
      listIssueComments,
      slo.complianceSettings.responseTime,
      issueUpdateTime
    );
    if (!isInResponseTime) {
      return false;
    }
  }

  return true;
};

getSLOStatus.isInResponseTime = async function isInResponseTime(
  responders: Set<string>,
  listIssueComments: IssuesListCommentsItem[] | null,
  resolutionTime: string | number,
  issueCreatedTime: string
): Promise<boolean> {
  if (!listIssueComments) {
    return true; //If API call to list issue comments failed, does not attempt to label the issue
  }
  for (const comment of listIssueComments) {
    if (responders.has(comment.user.login)) {
      const isValidTime = await getSLOStatus.isInDuration(
        resolutionTime,
        issueCreatedTime,
        comment.created_at
      );
      if (isValidTime) {
        return true;
      }
    }
  }
  return false;
};

getSLOStatus.isAssigned = async function isAssigned(
  responders: Set<string>,
  assignees: IssueAssignees[]
): Promise<boolean> {
  for (const assignee of assignees) {
    if (responders.has(assignee.login)) {
      return true;
    }
  }
  return false;
};

getSLOStatus.getIssueCommentsList = async function getIssueCommentsList(
  github: GitHubAPI,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<IssuesListCommentsItem[] | null> {
  try {
    const listComments = await github.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
    });
    return listComments.data;
  } catch (err) {
    console.error(
      `Error in getting issue comments for number ${issueNumber}\n ${err.request}`
    );
    return null;
  }
};

getSLOStatus.getResponders = async function getResponders(
  github: GitHubAPI,
  owner: string,
  repo: string,
  slo: SLORules
): Promise<Set<string>> {
  let responders: Set<string> = new Set([owner]);
  //Getting list of owners from a uri-reference
  let owners = slo.complianceSettings.responders?.owners;
  if (owners) {
    owners = await getSLOStatus.convertToArray(owners);
    for (const ownerPath of owners) {
      const content = await getSLOStatus.getFilePathContent(
        github,
        owner,
        repo,
        ownerPath
      );
      const users = content.match(/@([^\s]+)/g);

      users?.forEach(user => {
        if (user.length > 1) responders.add(user.substr(1));
      });
    }
  }
  //Getting list of contributers by checking collaborator list with correct permissions
  const contributors = slo.complianceSettings.responders?.contributors;
  if (contributors) {
    const collaborators = await getSLOStatus.getCollaborators(
      github,
      owner,
      repo
    );
    responders = await getSLOStatus.getContributers(
      owner,
      responders,
      contributors,
      collaborators
    );
  }

  //Getting valid users who can be responders if valid usernames are listed
  const users = slo.complianceSettings.responders?.users;
  users?.forEach(user => responders.add(user));

  return responders;
};

//Getting contributers depending on write, admin, and owner
getSLOStatus.getContributers = async function getContributers(
  owner: string,
  responders: Set<string>,
  contributors: string,
  collaborators: ReposListCollaboratorsItem[] | null
): Promise<Set<string>> {
  responders.add(owner);
  if (contributors === 'OWNER') {
    return responders;
  }

  if (collaborators) {
    for (const collab of collaborators) {
      if (
        (contributors === 'WRITE' &&
          collab.permissions.pull &&
          collab.permissions.push) ||
        collab.permissions.admin
      ) {
        responders.add(collab.login);
      } else if (contributors === 'ADMIN' && collab.permissions.admin) {
        responders.add(collab.login);
      }
    }
  }
  return responders;
};

getSLOStatus.getCollaborators = async function getCollaborators(
  github: GitHubAPI,
  owner: string,
  repo: string
): Promise<ReposListCollaboratorsItem[] | null> {
  try {
    const collaboratorList = await github.repos.listCollaborators({
      owner,
      repo,
    });
    return collaboratorList.data;
  } catch (err) {
    console.warn(`Error in getting list of collaborators \n ${err.request}`);
    return null;
  }
};

getSLOStatus.isInDuration = async function isInDuration(
  duration: string | number,
  startTime: string,
  endTime?: string
): Promise<boolean> {
  const start = moment(startTime);
  const end = endTime ? moment(endTime) : moment();
  let unit = '';
  let diff: number;

  if (typeof duration === 'string') {
    unit = duration.charAt(duration.length - 1);
    duration = Number(duration.substr(0, duration.length - 1));
  }
  if (unit === 'd') {
    diff = moment.duration(end.diff(start)).asDays();
  } else if (unit === 'h') {
    diff = moment.duration(end.diff(start)).asHours();
  } else if (unit === 'm') {
    diff = moment.duration(end.diff(start)).asMinutes();
  } else {
    diff = moment.duration(end.diff(start)).asSeconds();
  }

  return diff <= duration;
};

export async function getSLOStatus(
  github: GitHubAPI,
  owner: string,
  repo: string,
  issueCreatedTime: string,
  assignees: IssueAssignees[],
  issueNumber: number,
  type: string,
  slo: SLORules, //Set default values for issues, prs, & assigned
  labels: string[] | null
): Promise<SLOStatus> {
  //Checks if issue applies to slo only if slo has applies to specifications
  const appliesTo = await getSLOStatus.doesSloApply(type, slo, labels);
  let isCompliant = null;

  if (appliesTo) {
    isCompliant = await getSLOStatus.isCompliant(
      github,
      owner,
      repo,
      issueNumber,
      assignees,
      issueCreatedTime,
      slo
    );
  }

  return {
    appliesTo: appliesTo,
    isCompliant: isCompliant,
  } as SLOStatus;
}