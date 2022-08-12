import React from 'react';
import { Components, registerComponent, getFragment } from '../../lib/vulcan-lib';
import Reports from '../../lib/collections/reports/collection'
import DialogContent from '@material-ui/core/DialogContent';

const ReportForm = ({ userId, postId, commentId, reportedUserId, onClose, title, link }: {
  userId: string,
  postId?: string,
  commentId?: string,
  reportedUserId?: string,
  onClose?: ()=>void,
  title?: string,
  link: string,
}) => {
  return (
    <Components.LWDialog
      title={title}
      open={true}
      onClose={onClose}
    >
      <DialogContent>
        <Components.WrappedSmartForm
          collection={Reports}
          mutationFragment={getFragment('unclaimedReportsList')}
          prefilledProps={{
            userId: userId,
            postId: postId,
            reportedUserId: reportedUserId,
            commentId: commentId,
            link: link
          }}
          successCallback={onClose}
        />
      </DialogContent>
    </Components.LWDialog>
  )
}

const ReportFormComponent = registerComponent('ReportForm', ReportForm);

declare global {
  interface ComponentTypes {
    ReportForm: typeof ReportFormComponent
  }
}

