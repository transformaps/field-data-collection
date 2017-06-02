import React, { Component } from "react";
import { addNavigationHelpers } from "react-navigation";
import { connect } from "react-redux";

import Navigator from "./navigator";

const mapStateToProps = state => {
  return {
    navigationState: state.observations
  };
};

class Observations extends Component {
  render() {
    const { dispatch, navigationState } = this.props;

    return (
      <Navigator
        navigation={addNavigationHelpers({
          dispatch,
          state: navigationState
        })}
      />
    );
  }
}

export default connect(mapStateToProps)(Observations);
