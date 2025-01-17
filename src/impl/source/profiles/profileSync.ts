import { Sfpowerkit, LoggerLevel } from '../../../sfpowerkit';
import * as fs from 'fs-extra';
import Profile from '../../../impl/metadata/schema';
import * as _ from 'lodash';
import ProfileActions, { ProfileStatus, ProfileSourceFile } from './profileActions';
import ProfileWriter from '../../../impl/metadata/writer/profileWriter';
import { ProgressBar } from '../../../ui/progressBar';
import MetadataRetriever from '../../metadata/retriever/metadataRetriever';
import { registry } from '@salesforce/source-deploy-retrieve';
import * as path from 'path';

export default class ProfileSync extends ProfileActions {
    public async sync(srcFolders: string[], profilesToSync?: string[], isdelete?: boolean): Promise<ProfileStatus> {
        Sfpowerkit.log('Retrieving profiles', LoggerLevel.DEBUG);

        //Display provided profiles if any
        if (!_.isNil(profilesToSync) && profilesToSync.length !== 0) {
            Sfpowerkit.log('Requested  profiles are..', LoggerLevel.DEBUG);
            Sfpowerkit.log(profilesToSync, LoggerLevel.DEBUG);
        }

        //Fetch all profiles if source folders if not provided
        let isToFetchNewProfiles = _.isNil(srcFolders) || srcFolders.length === 0;

        Sfpowerkit.log('Source Folders are', LoggerLevel.DEBUG);
        Sfpowerkit.log(srcFolders, LoggerLevel.DEBUG);

        //get local profiles when profile path is provided
        let profilesInProjectDir = await this.loadProfileFromPackageDirectories(srcFolders);

        //If dont fetch add those to profilesToSync
        if (!isToFetchNewProfiles && profilesToSync.length < 1) {
            profilesInProjectDir.forEach((element) => {
                profilesToSync.push(element.name);
            });
        }

        //Grab status of the profiles (Add, Update or Delete)
        let profileStatus = await this.getRemoteProfilesWithLocalStatus(profilesToSync, srcFolders);

        let profilesToRetrieve: ProfileSourceFile[] = [];
        if (isToFetchNewProfiles) {
            //Retriving local profiles and anything extra found in the org
            profilesToRetrieve = _.union(profileStatus.added, profileStatus.updated);
        } else {
            //Retriving only local profiles
            profilesToRetrieve = profileStatus.updated;
            profileStatus.added = [];
        }
        profilesToRetrieve.sort((a, b) => a.name.localeCompare(b.name));
        Sfpowerkit.log(`Number of profiles to retrieve ${profilesToRetrieve.length}`, LoggerLevel.INFO);

        if (profilesToRetrieve.length > 0) {
            let i: number,
                j: number,
                chunk = 10;
            let profilesToRetrieveChunked: any[] = [];

            let progressBar = new ProgressBar().create(`Loading profiles in batches `, ` Profiles`, LoggerLevel.INFO);
            progressBar.start(profilesToRetrieve.length);
            for (i = 0, j = profilesToRetrieve.length; i < j; i += chunk) {
                //slice profilesToRetrieve in chunk
                profilesToRetrieveChunked = profilesToRetrieve.slice(i, i + chunk);
                let remoteProfiles = await this.profileRetriever.loadProfiles(
                    _.uniq(
                        profilesToRetrieveChunked.map((elem) => {
                            return elem.name;
                        })
                    )
                );

                let profileWriter = new ProfileWriter();
                for (let count = 0; count < remoteProfiles.length; count++) {
                    let profileObj = remoteProfiles[count] as Profile;
                    Sfpowerkit.log('Reconciling  Tabs', LoggerLevel.DEBUG);
                    await this.reconcileTabs(profileObj);
                    //Find correct profile path, so that remote could be overlaid
                    let indices = _.keys(_.pickBy(profilesToRetrieveChunked, { name: profileObj.fullName }));
                    for (const index of indices) {
                        let filePath = profilesToRetrieveChunked[index].path;
                        if (filePath) {
                            profileWriter.writeProfile(
                                profileObj,
                                path.join(process.cwd(), profilesToRetrieveChunked[index].path)
                            );
                        } else {
                            Sfpowerkit.log('File path not found...', LoggerLevel.DEBUG);
                        }
                    }
                }
                progressBar.increment(j - i > chunk ? chunk : j - i);
            }
            progressBar.stop();
        } else {
            Sfpowerkit.log(`No Profiles found to retrieve`, LoggerLevel.INFO);
        }

        if (profileStatus.deleted && isdelete) {
            profileStatus.deleted.forEach((profile) => {
                if (fs.existsSync(path.join(process.cwd(), profile.path))) {
                    fs.unlinkSync(path.join(process.cwd(), profile.path));
                }
            });
        }
        //Retun final status
        return profileStatus;
    }

    private async reconcileTabs(profileObj: Profile): Promise<void> {
        let tabRetriever = new MetadataRetriever(this.org.getConnection(), registry.types.customtab.name);

        if (profileObj.tabVisibilities !== undefined) {
            if (!Array.isArray(profileObj.tabVisibilities)) {
                profileObj.tabVisibilities = [profileObj.tabVisibilities];
            }
            let validArray = [];
            for (let i = 0; i < profileObj.tabVisibilities.length; i++) {
                let cmpObj = profileObj.tabVisibilities[i];
                let exist = await tabRetriever.isComponentExistsInProjectDirectoryOrInOrg(cmpObj.tab);
                if (exist) {
                    validArray.push(cmpObj);
                }
            }
            Sfpowerkit.log(
                `Tab Visibilities reduced from ${profileObj.tabVisibilities.length}  to  ${validArray.length}`,
                LoggerLevel.DEBUG
            );
            profileObj.tabVisibilities = validArray;
        }
    }
}
